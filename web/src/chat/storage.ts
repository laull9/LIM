import Dexie from 'dexie'
import type { EntityTable, Table } from 'dexie'
import { decodeBody } from './protocol'
import type { Conversation, Identity, WireEvent } from './protocol'

export interface SavedMessage {
  room: string
  order: string
  seq: string
  device: string
  id: string
  type: WireEvent['content_type']
  text: string
  account?: string
  username?: string
  display_name?: string
  receivedAt?: number
}

interface Cursor {
  room: string
  floor: string
  before: string
  after: string
  prepended: number
}

export interface PendingMessage {
  id: string
  room: string
  text: string
  queuedAt: number
  status: 'queued' | 'accepted' | 'failed'
  acceptedSeq?: string
  issue?: string
}

interface CachedConversation {
  scope: string
  id: string
  conversation: Conversation
}

const db = new Dexie('lim-web') as Dexie & {
  cursors: EntityTable<Cursor, 'room'>
  messages: Table<SavedMessage, [string, string]>
  outbox: EntityTable<PendingMessage, 'id'>
  conversations: Table<CachedConversation, [string, string]>
}

db.version(1).stores({
  cursors: 'room',
  messages: '[room+order]',
  outbox: 'id, room',
})

db.version(2).stores({
  cursors: 'room',
  messages: '[room+order]',
  outbox: 'id, room',
  conversations: '[scope+id], scope',
})

const order = (seq: string) => seq.padStart(19, '0')
const history = (room: string) => db.messages.where('[room+order]')
  .between([room, Dexie.minKey], [room, Dexie.maxKey], true, true)

export const roomKey = (identity: Identity, id: string) => `${identity.generation}/${identity.device}/${id}`
export const directoryScope = (identity: Identity) => `${identity.generation}/${identity.device}`

export function recentBoundary(floor: string, high: string) {
  const recent = BigInt(high) - 48n
  return (recent > BigInt(floor) ? recent : BigInt(floor)).toString()
}

export function position(room: string) {
  return db.cursors.get(room)
}

export function openRoom(room: string, conversation: Conversation) {
  return db.transaction('rw', db.cursors, db.messages, db.outbox, async () => {
    const current = await db.cursors.get(room)
    if (!current) {
      const boundary = recentBoundary(conversation.after, conversation.last_seq)
      const cursor = { room, floor: conversation.after, before: boundary, after: boundary, prepended: 0 }
      await db.cursors.add(cursor)
    } else if (BigInt(conversation.after) > BigInt(current.floor)) {
      await advanceFloor(current, conversation.after)
    }
  })
}

async function advanceFloor(cursor: Cursor, floor: string) {
  const { room } = cursor
  const boundary = BigInt(floor)
  await db.messages.where('[room+order]').between([room, Dexie.minKey], [room, order(floor)], true, true).delete()
  await db.outbox.where('room').equals(room)
    .and((item) => item.acceptedSeq !== undefined && BigInt(item.acceptedSeq) <= boundary).delete()
  await db.cursors.put({
    ...cursor,
    floor,
    before: boundary > BigInt(cursor.before) ? floor : cursor.before,
    after: boundary > BigInt(cursor.after) ? floor : cursor.after,
    prepended: 0,
  })
}

export function setFloor(room: string, floor: string) {
  return db.transaction('rw', db.cursors, db.messages, db.outbox, async () => {
    const cursor = await db.cursors.get(room)
    if (cursor && BigInt(floor) > BigInt(cursor.floor)) await advanceFloor(cursor, floor)
  })
}

export async function readDirectory(scope: string) {
  const rows = await db.conversations.where('scope').equals(scope).toArray()
  return rows.map((row) => row.conversation)
}

export function saveDirectory(scope: string, conversations: Conversation[]) {
  return db.transaction('rw', db.conversations, async () => {
    await db.conversations.where('scope').equals(scope).delete()
    await db.conversations.bulkPut(conversations.map((conversation) => ({
      scope,
      id: conversation.conversation_id,
      conversation,
    })))
  })
}

export function clearCachedChats() {
  return db.transaction('rw', db.cursors, db.messages, db.outbox, db.conversations, async () => {
    await Promise.all([db.cursors.clear(), db.messages.clear(), db.outbox.clear(), db.conversations.clear()])
  })
}

export function readTimeline(room: string) {
  return db.transaction('r', db.messages, db.cursors, db.outbox, async () => {
    const [messages, cursor, pending] = await Promise.all([
      history(room).toArray(),
      db.cursors.get(room),
      db.outbox.where('room').equals(room).sortBy('queuedAt'),
    ])
    return { messages, cursor, pending }
  })
}

export function readAllQueued(scope: string) {
  const prefix = `${scope}/`
  return db.outbox.filter((item) => item.room.startsWith(prefix)).toArray()
}

export function saveEvents(
  room: string,
  expected: Cursor,
  events: WireEvent[],
  boundary: string,
  direction: 'forward' | 'backward',
) {
  const receivedAt = Date.now()
  const messages = events.map((event) => ({
    room,
    order: order(event.seq),
    seq: event.seq,
    device: event.device_id,
    id: event.client_message_id,
    type: event.content_type,
    text: decodeBody(event),
    account: event.account_id,
    username: event.username,
    display_name: event.display_name,
    receivedAt,
  }))
  return db.transaction('rw', db.messages, db.cursors, db.outbox, async () => {
    const cursor = await db.cursors.get(room)
    const field = direction === 'forward' ? 'after' : 'before'
    if (!cursor || cursor.floor !== expected.floor || cursor[field] !== expected[field]) return false
    await db.messages.bulkPut(messages)
    const arrivedIds = messages.map((item) => item.id)
    if (arrivedIds.length) {
      await db.outbox.where('id').anyOf(arrivedIds).and((item) => item.room === room).delete()
    }
    await db.cursors.put({
      ...cursor,
      [field]: boundary,
      prepended: direction === 'backward' ? cursor.prepended + messages.length : cursor.prepended,
    })
    return true
  })
}

export async function enqueue(room: string, text: string) {
  await db.outbox.add({ id: crypto.randomUUID(), room, text, queuedAt: Date.now(), status: 'queued' })
}

export function acknowledge(room: string, id: string, seq: string) {
  return db.transaction('rw', db.cursors, db.outbox, async () => {
    const cursor = await db.cursors.get(room)
    if (cursor && BigInt(seq) <= BigInt(cursor.floor)) {
      await db.outbox.delete(id)
    } else {
      await db.outbox.update(id, { status: 'accepted', acceptedSeq: seq })
    }
  })
}

export async function markFailed(id: string, issue: string) {
  await db.outbox.update(id, { status: 'failed', issue })
}

export async function retryPending(id: string) {
  const item = await db.outbox.get(id)
  if (!item) return
  await db.outbox.put({
    id: item.id,
    room: item.room,
    text: item.text,
    queuedAt: item.queuedAt,
    status: 'queued',
  })
}

export async function deletePending(id: string) {
  await db.outbox.delete(id)
}

export async function forgetRoom(room: string) {
  await db.transaction('rw', db.messages, db.cursors, db.outbox, async () => {
    await history(room).delete()
    await db.cursors.delete(room)
    await db.outbox.where('room').equals(room).delete()
  })
}
