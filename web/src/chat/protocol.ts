import { z } from 'zod'

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
const sequence = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807')
const sessionInfo = z.object({ generation: uuid, account: uuid, device: uuid })
const conversation = z.object({
  conversation_id: uuid,
  after: sequence,
  last_seq: sequence,
  profile: z.literal('host'),
}).refine(({ after, last_seq }) => BigInt(after) <= BigInt(last_seq))
const contentType = z.enum(['text/plain', 'application/json', 'application/octet-stream'])
const event = z.object({
  seq: sequence,
  device_id: uuid,
  client_message_id: uuid,
  content_type: contentType,
  payload_base64: z.base64().min(1),
})
const eventPage = z.object({ events: z.array(event), up_to: sequence, next_after: sequence })
const receipt = z.object({ seq: sequence, replayed: z.boolean() })
const directoryPage = z.object({ conversations: z.array(conversation), next_after: uuid.nullable() })
const errorDetail = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.object({ name: z.string().optional(), retryable: z.boolean().optional(), sequence: sequence.optional() }).optional(),
})
const rpcResponse = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: uuid, result: z.unknown() }),
  z.object({ jsonrpc: z.literal('2.0'), id: uuid.nullable(), error: errorDetail }),
])
const syncHint = z.object({
  v: z.literal(1),
  type: z.literal('sync.hint'),
  recovery_generation: uuid,
  conversation_id: uuid,
  up_to: sequence,
})

export type Identity = z.infer<typeof sessionInfo>
export type Conversation = z.infer<typeof conversation>
export type WireEvent = z.infer<typeof event>

const errors: Record<string, string> = {
  unauthenticated: '设备令牌无效或已失效。',
  device_revoked: '此设备已被撤销。',
  not_found_or_forbidden: '此会话已不存在或设备已失去访问权限。',
  recovery_required: '服务已切换恢复代次。请重新连接设备。',
  cursor_expired: '部分历史消息已过期。',
  payload_too_large: '消息超过 64 KiB。',
  idempotency_expired: '这条消息的原始发送记录已过期。',
  idempotency_conflict: '此消息与服务端已有的发送记录冲突。',
  overloaded: '服务繁忙，正在重试。',
  temporarily_unavailable: '服务暂时不可用，正在重试。',
  network: '连接已中断，正在重试。',
  invalid_response: '服务器返回了无法识别的响应。',
}

export class LimError extends Error {
  readonly kind: string
  readonly retryable: boolean
  readonly sequence: string | undefined

  constructor(kind: string, retryable = false, seq?: string) {
    super(errors[kind] ?? '请求失败，请稍后重试。')
    this.kind = kind
    this.retryable = retryable
    this.sequence = seq
  }
}

export function explain(error: unknown) {
  return error instanceof LimError ? error.message : '操作失败，请重试。'
}

export function sessionEnded(error: unknown) {
  return error instanceof LimError
    && ['unauthenticated', 'device_revoked', 'recovery_required'].includes(error.kind)
}

export function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    function abort() {
      window.clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function request(path: string, token: string, options: RequestInit, signal: AbortSignal) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  let response: Response
  try {
    response = await fetch(path, {
      ...options,
      cache: 'no-store',
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new LimError('network', true)
  }
  if (response.ok) return response
  if (response.status === 401) throw new LimError('unauthenticated')
  if (response.status === 429 || response.status === 503) throw new LimError('overloaded', true)
  if (response.status >= 500) throw new LimError('temporarily_unavailable', true)
  const body = z.object({ code: z.string(), sequence: sequence.optional() })
    .safeParse(await json(response))
  if (!body.success) throw new LimError('invalid_response')
  throw new LimError(body.data.code, false, body.data.sequence)
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    if (error instanceof SyntaxError) throw new LimError('invalid_response')
    throw new LimError('network', true)
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value)
  if (!result.success) throw new LimError('invalid_response')
  return result.data
}

export class LimClient {
  readonly #token: string

  constructor(token: string) {
    this.#token = token
  }

  private async rpc<T>(method: string, params: object, schema: z.ZodType<T>, signal: AbortSignal) {
    const id = crypto.randomUUID()
    const response = await request('/rpc', this.#token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }, signal)
    const reply = parse(rpcResponse, await json(response))
    if ('error' in reply) {
      if (reply.id !== id && reply.id !== null) throw new LimError('invalid_response')
      const { code, data } = reply.error
      throw new LimError(data?.name ?? (code === -32001 ? 'unauthenticated' : 'rpc_error'),
        data?.retryable, data?.sequence)
    }
    if (reply.id !== id) throw new LimError('invalid_response')
    return parse(schema, reply.result)
  }

  identify(signal: AbortSignal) {
    return this.rpc('session.info', {}, sessionInfo, signal)
  }

  async conversations(generation: string, signal: AbortSignal) {
    const result: Conversation[] = []
    let after: string | undefined
    do {
      const page = await this.rpc('conversation.list', { generation, after }, directoryPage, signal)
      if (page.next_after && after && page.next_after <= after) throw new LimError('invalid_response')
      result.push(...page.conversations)
      after = page.next_after ?? undefined
    } while (after)
    return result
  }

  async events(generation: string, room: string, after: string, upTo: string | undefined, signal: AbortSignal) {
    const page = await this.rpc('conversation.events', {
      generation, conversation_id: room, after, up_to: upTo,
    }, eventPage, signal)
    let cursor = BigInt(after)
    for (const item of page.events) {
      cursor += 1n
      if (BigInt(item.seq) !== cursor) throw new LimError('invalid_response')
    }
    if ((upTo !== undefined && page.up_to !== upTo)
      || BigInt(page.next_after) !== cursor || BigInt(page.up_to) < cursor
      || (page.next_after === after && page.up_to !== after)) {
      throw new LimError('invalid_response')
    }
    return page
  }

  async wait(generation: string, room: string, after: string, signal: AbortSignal) {
    const response = await request(`/v1/conversations/${room}/wait?after_seq=${after}`, this.#token, {
      headers: { 'LIM-Generation': generation },
    }, signal)
    if (response.headers.get('LIM-Generation') !== generation) throw new LimError('recovery_required')
    if (response.status === 204) return false
    const hint = parse(syncHint, await json(response))
    if (hint.recovery_generation !== generation || hint.conversation_id !== room
      || BigInt(hint.up_to) <= BigInt(after)) {
      throw new LimError('invalid_response')
    }
    return true
  }

  send(generation: string, room: string, id: string, text: string, signal: AbortSignal) {
    return this.rpc('message.send', {
      generation,
      conversation_id: room,
      client_message_id: id,
      content_type: 'text/plain',
      text,
    }, receipt, signal)
  }
}

export function decodeBody(item: WireEvent) {
  const bytes = Uint8Array.from(atob(item.payload_base64), (byte) => byte.charCodeAt(0))
  if (item.content_type === 'application/octet-stream') return `二进制消息 · ${bytes.length} 字节`
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return '此消息包含无效的 UTF-8。'
  }
}
