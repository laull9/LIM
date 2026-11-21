import { delay, explain, LimError, sessionEnded } from './protocol'
import type { Conversation, Identity, LimClient, WireEvent } from './protocol'
import {
  acknowledge, markFailed, openRoom, position, recentBoundary, saveEvents, setFloor,
} from './storage'
import type { PendingMessage } from './storage'

export type SyncStatus = { state: 'loading' | 'online' | 'offline' | 'blocked'; detail?: string }

export interface RoomConnection {
  client: LimClient
  identity: Identity
  conversation: Conversation
  room: string
}

async function fillForward(connection: RoomConnection, signal: AbortSignal) {
  const { client, identity, conversation, room } = connection
  let upTo: string | undefined
  while (!signal.aborted) {
    const cursor = await position(room)
    if (!cursor) return
    if (upTo !== undefined && BigInt(cursor.after) >= BigInt(upTo)) return
    const page = await client.events(identity.generation, conversation.conversation_id, cursor.after, upTo, signal)
    signal.throwIfAborted()
    const saved = await saveEvents(room, cursor, page.events, page.next_after, 'forward')
    if (saved && page.next_after === page.up_to) return
    upTo = page.up_to
  }
}

export async function synchronizeRoom(
  connection: RoomConnection,
  signal: AbortSignal,
  status: (value: SyncStatus) => void,
  fail: (error: unknown) => void,
) {
  const { client, identity, conversation, room } = connection
  let retryMs = 1000
  while (!signal.aborted) {
    try {
      await openRoom(room, conversation)
      await fillForward(connection, signal)
      signal.throwIfAborted()
      status({ state: 'online' })
      retryMs = 1000
      while (!signal.aborted) {
        const cursor = await position(room)
        if (!cursor) return
        if (await client.wait(identity.generation, conversation.conversation_id, cursor.after, signal)) break
      }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof LimError && error.kind === 'cursor_expired' && error.sequence) {
        await setFloor(room, error.sequence)
        continue
      }
      if (!(error instanceof LimError) || !error.retryable) {
        status({ state: 'blocked', detail: explain(error) })
        fail(error)
        return
      }
      status({ state: 'offline', detail: explain(error) })
      await delay(retryMs, signal)
      retryMs = Math.min(retryMs * 2, 8000)
    }
  }
}

export async function loadOlder(connection: RoomConnection, signal: AbortSignal) {
  const { client, identity, conversation, room } = connection
  const cursor = await position(room)
  if (!cursor || cursor.before === cursor.floor) return
  const boundary = recentBoundary(cursor.floor, cursor.before)
  let after = boundary
  const events: WireEvent[] = []
  try {
    while (after !== cursor.before) {
      const page = await client.events(identity.generation, conversation.conversation_id, after, cursor.before, signal)
      events.push(...page.events)
      after = page.next_after
    }
    signal.throwIfAborted()
    await saveEvents(room, cursor, events, boundary, 'backward')
  } catch (error) {
    if (!signal.aborted && error instanceof LimError && error.kind === 'cursor_expired' && error.sequence) {
      await setFloor(room, error.sequence)
    }
    throw error
  }
}

export async function deliver(
  { client, identity, conversation }: RoomConnection,
  message: PendingMessage,
  signal: AbortSignal,
  fail: (error: unknown) => void,
) {
  let retryMs = 1000
  while (!signal.aborted) {
    let receipt
    try {
      receipt = await client.send(
        identity.generation,
        conversation.conversation_id,
        message.id,
        message.text,
        signal,
        message.contentType ?? 'text/plain',
      )
    } catch (error) {
      if (signal.aborted) return
      if (sessionEnded(error) || (error instanceof LimError && error.kind === 'not_found_or_forbidden')) {
        fail(error)
        return
      }
      if (error instanceof LimError && !error.retryable && error.kind !== 'invalid_response') {
        await markFailed(message.id, explain(error))
        return
      }
      await delay(retryMs, signal)
      retryMs = Math.min(retryMs * 2, 8000)
      continue
    }
    await acknowledge(message.room, message.id, receipt.seq)
    return
  }
}
