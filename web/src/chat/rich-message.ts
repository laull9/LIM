import type { PendingMessage, SavedMessage } from './storage'
import type { SendContentType } from './protocol'

export interface MediaRef {
  mediaId: string
  mime: string
  name: string
  size: number
  width?: number
  height?: number
  duration?: number
}

export interface ReplyRef {
  seq: string
  sender: string
  preview: string
}

export type RichPayload =
  | { v: 1; lim_msg: true; kind: 'text'; text: string; replyTo?: ReplyRef; ts?: number }
  | { v: 1; lim_msg: true; kind: 'image'; images: MediaRef[]; text?: string; replyTo?: ReplyRef; ts?: number }
  | { v: 1; lim_msg: true; kind: 'video'; video: MediaRef; text?: string; replyTo?: ReplyRef; ts?: number }
  | { v: 1; lim_msg: true; kind: 'voice'; voice: { mediaId: string; mime: string; duration: number; waveform: number[] }; replyTo?: ReplyRef; ts?: number }
  | { v: 1; lim_msg: true; kind: 'file'; file: MediaRef & { ext: string }; text?: string; replyTo?: ReplyRef; ts?: number }
  | { v: 1; lim_msg: true; kind: 'code'; code: { lang: string; content: string }; text?: string; replyTo?: ReplyRef; ts?: number }
  | { v: 1; lim_msg: true; kind: 'location'; location: { name: string; address: string; lat?: number; lng?: number }; replyTo?: ReplyRef; ts?: number }
  | { v: 1; lim_msg: true; kind: 'poll'; poll: { question: string; options: string[] }; replyTo?: ReplyRef; ts?: number }
  | { v: 1; lim_msg: true; kind: 'system'; title?: string; text: string; ts?: number }
  | { v: 1; lim_msg: true; kind: 'reaction'; targetSeq: string; emoji: string; op: 'add' | 'remove'; ts?: number }
  | { v: 1; lim_msg: true; kind: 'poll_vote'; targetSeq: string; option: number; ts?: number }
  | { v: 1; lim_msg: true; kind: 'pin'; targetSeq: string; pinned: boolean; ts?: number }
  | { v: 1; lim_msg: true; kind: 'recall'; targetSeq: string; ts?: number }

export type DisplayKind =
  | 'text'
  | 'raw_json'
  | 'image'
  | 'video'
  | 'voice'
  | 'file'
  | 'code'
  | 'location'
  | 'poll'
  | 'system'

export interface ReactionSummary {
  emoji: string
  accounts: string[]
  names: string[]
}

export interface ProjectedMessage {
  raw: SavedMessage | PendingMessage
  pending: boolean
  seq?: string
  id: string
  senderId: string
  senderName: string
  own: boolean
  ts: number
  kind: DisplayKind
  rich?: RichPayload
  text: string
  replyTo?: ReplyRef
  reactions: ReactionSummary[]
  pollVotes: Map<number, string[]>
  pinned: boolean
  recalled: boolean
}

export interface ProjectedMediaItem {
  seq: string
  kind: 'image' | 'video'
  media: MediaRef
  senderName: string
  ts: number
}

export interface ProjectedFileItem {
  seq: string
  file: MediaRef & { ext: string }
  senderName: string
  ts: number
}

export interface ProjectedTimeline {
  messages: ProjectedMessage[]
  bySeq: Map<string, ProjectedMessage>
  media: ProjectedMediaItem[]
  files: ProjectedFileItem[]
  pinned: ProjectedMessage[]
}

export const QUICK_REACTIONS = ['👍', '🌊', '❤️', '😂', '🔥', '👀', '🙌', '✅']

export const EMOJI_SET: Record<string, string[]> = {
  常用: ['👍', '🌊', '❤️', '😂', '🔥', '👀', '🙌', '✅', '🎉', '🙏', '😮', '😢'],
  表情: ['😀', '😄', '😁', '😆', '🥹', '😊', '😇', '🙂', '😉', '😌', '😍', '🥰', '😘', '😋', '😛', '🤔', '🤨', '😐', '😑', '😶', '🙄', '😏', '😴', '🤯', '😎', '🥳', '😤', '😭', '🥶', '🤝'],
  自然: ['🌊', '🐚', '🐳', '🐬', '🦀', '🐠', '🪸', '🏝️', '⛵', '🌅', '🌙', '⭐', '☀️', '🌧️', '🌈', '🍃', '🌴', '🪼'],
  物品: ['💻', '📱', '⌚', '🎧', '📷', '🎬', '🎙️', '📎', '📌', '✏️', '📐', '🧭', '🗺️', '⚓', '💡'],
  符号: ['✨', '💯', '❗', '❓', '➕', '➖', '✖️', '➡️', '⬅️', '🔁', '🔔', '🔕', '♻️', '⚠️', '🆗'],
}

export type ControlPayload = Extract<RichPayload, { kind: 'reaction' | 'poll_vote' | 'pin' | 'recall' }>

export function isControlKind(kind: RichPayload['kind']) {
  return kind === 'reaction' || kind === 'poll_vote' || kind === 'pin' || kind === 'recall'
}

export function isControlPayload(payload: RichPayload): payload is ControlPayload {
  return isControlKind(payload.kind)
}

export function parseRichMessage(contentType: SendContentType | 'application/octet-stream' | undefined, rawText: string): RichPayload | null {
  if (contentType !== 'application/json') return null
  try {
    const parsed: unknown = JSON.parse(rawText)
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as Partial<RichPayload>
    if (candidate.v !== 1 || candidate.lim_msg !== true || typeof candidate.kind !== 'string') {
      return null
    }
    return candidate as RichPayload
  } catch {
    return null
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDuration(seconds: number) {
  const clean = Math.max(0, Math.floor(seconds))
  return `${Math.floor(clean / 60)}:${String(clean % 60).padStart(2, '0')}`
}

export function formatClock(ts: number) {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatDayDivider(ts: number) {
  const date = new Date(ts)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return '今天'
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekdays[date.getDay()]}`
}

export function sameCalendarDay(a: number, b: number) {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

export function fileExtension(filename: string, mime = '') {
  const dot = filename.lastIndexOf('.')
  if (dot > 0 && dot < filename.length - 1) {
    return filename.slice(dot + 1).toLowerCase().slice(0, 8)
  }
  const slash = mime.indexOf('/')
  if (slash >= 0) return mime.slice(slash + 1).split(';')[0].toLowerCase().slice(0, 8)
  return 'file'
}

export function summarizeContent(contentType: SendContentType | 'application/octet-stream' | undefined, rawText: string): string | null {
  const rich = parseRichMessage(contentType, rawText)
  if (!rich) return rawText.trim().slice(0, 80)
  if (isControlKind(rich.kind)) return null
  switch (rich.kind) {
    case 'image':
      return rich.text ? `📷 ${rich.text}` : rich.images.length > 1 ? `📷 ${rich.images.length} 张照片` : '📷 照片'
    case 'video':
      return rich.text ? `🎬 ${rich.text}` : `🎬 ${rich.video.name || '视频'}`
    case 'voice':
      return `🎙 语音 ${formatDuration(rich.voice.duration)}`
    case 'file':
      return `📎 ${rich.file.name}`
    case 'code':
      return `⌘ ${rich.code.lang || '代码'} 片段`
    case 'location':
      return `📍 ${rich.location.name}`
    case 'poll':
      return `📊 投票：${rich.poll.question}`
    case 'system':
      return rich.title ? `${rich.title} · ${rich.text}` : rich.text
    case 'text':
      return rich.text
  }
}

export function summarizeProjected(msg: ProjectedMessage): string {
  if (msg.recalled) return '此消息已撤回'
  if (msg.rich) {
    return summarizeContent('application/json', JSON.stringify(msg.rich)) ?? msg.text
  }
  return msg.text
}

function actorName(item: SavedMessage | PendingMessage, ownName: string) {
  if ('status' in item) return ownName
  if (item.display_name) return item.display_name
  if (item.username) return `@${item.username}`
  return `设备 ${item.device.slice(-2).toUpperCase()}`
}

export function projectTimeline(
  items: (SavedMessage | PendingMessage)[],
  ownAccount: string,
  ownDevice: string,
  ownName: string,
): ProjectedTimeline {
  const messages: ProjectedMessage[] = []
  const bySeq = new Map<string, ProjectedMessage>()
  const reactionState = new Map<string, Map<string, Map<string, string>>>()
  const voteState = new Map<string, Map<string, number>>()

  for (const item of items) {
    const pending = 'status' in item
    const contentType = pending ? (item.contentType ?? 'text/plain') : item.type
    const rich = parseRichMessage(contentType, item.text)
    const senderId = pending ? ownAccount : (item.account ?? item.device)
    const senderName = actorName(item, ownName)

    if (rich && isControlPayload(rich)) {
      const target = bySeq.get(rich.targetSeq)
      if (!target) continue
      if (rich.kind === 'reaction') {
        let emojiMap = reactionState.get(rich.targetSeq)
        if (!emojiMap) {
          emojiMap = new Map()
          reactionState.set(rich.targetSeq, emojiMap)
        }
        let users = emojiMap.get(rich.emoji)
        if (!users) {
          users = new Map()
          emojiMap.set(rich.emoji, users)
        }
        if (rich.op === 'add') users.set(senderId, senderName)
        else users.delete(senderId)
      } else if (rich.kind === 'poll_vote') {
        let votes = voteState.get(rich.targetSeq)
        if (!votes) {
          votes = new Map()
          voteState.set(rich.targetSeq, votes)
        }
        votes.set(senderId, rich.option)
      } else if (rich.kind === 'pin') {
        target.pinned = rich.pinned
      } else if (rich.kind === 'recall') {
        if (senderId === target.senderId) {
          target.recalled = true
          target.pinned = false
        }
      }
      continue
    }

    const own = pending || (item.account ? item.account === ownAccount : item.device === ownDevice)
    const ts = rich?.ts ?? (pending ? item.queuedAt : (item.receivedAt ?? Date.now()))
    let kind: DisplayKind = 'text'
    let text = item.text
    let replyTo: ReplyRef | undefined
    if (rich) {
      kind = rich.kind as DisplayKind
      if ('text' in rich && typeof rich.text === 'string') text = rich.text
      else text = ''
      if ('replyTo' in rich && rich.replyTo) replyTo = rich.replyTo
    } else if (contentType === 'application/json') {
      kind = 'raw_json'
    }

    const projected: ProjectedMessage = {
      raw: item,
      pending,
      seq: pending ? undefined : item.seq,
      id: item.id,
      senderId,
      senderName,
      own: kind === 'system' ? false : own,
      ts,
      kind,
      rich: rich ?? undefined,
      text,
      replyTo,
      reactions: [],
      pollVotes: new Map(),
      pinned: false,
      recalled: false,
    }
    messages.push(projected)
    if (!pending) bySeq.set(item.seq, projected)
  }

  for (const [seq, emojiMap] of reactionState) {
    const target = bySeq.get(seq)
    if (!target || target.recalled) continue
    const list: ReactionSummary[] = []
    for (const [emoji, users] of emojiMap) {
      if (users.size === 0) continue
      list.push({
        emoji,
        accounts: Array.from(users.keys()),
        names: Array.from(users.values()),
      })
    }
    target.reactions = list
  }

  for (const [seq, votes] of voteState) {
    const target = bySeq.get(seq)
    if (!target || target.recalled) continue
    const grouped = new Map<number, string[]>()
    for (const [account, option] of votes) {
      const voters = grouped.get(option) ?? []
      voters.push(account)
      grouped.set(option, voters)
    }
    target.pollVotes = grouped
  }

  const media: ProjectedMediaItem[] = []
  const files: ProjectedFileItem[] = []
  const pinned: ProjectedMessage[] = []

  for (const msg of messages) {
    if (msg.recalled || !msg.seq) continue
    if (msg.pinned) pinned.push(msg)
    if (msg.rich?.kind === 'image') {
      for (const img of msg.rich.images) {
        media.push({ seq: msg.seq, kind: 'image', media: img, senderName: msg.senderName, ts: msg.ts })
      }
    } else if (msg.rich?.kind === 'video') {
      media.push({ seq: msg.seq, kind: 'video', media: msg.rich.video, senderName: msg.senderName, ts: msg.ts })
    } else if (msg.rich?.kind === 'file') {
      files.push({ seq: msg.seq, file: msg.rich.file, senderName: msg.senderName, ts: msg.ts })
    }
  }

  return { messages, bySeq, media: media.reverse(), files: files.reverse(), pinned: pinned.reverse() }
}
