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

const db = new Dexie('lim-web') as Dexie & {
  cursors: EntityTable<Cursor, 'room'>
  messages: Table<SavedMessage, [string, string]>
  outbox: EntityTable<PendingMessage, 'id'>
}

db.version(1).stores({
  cursors: 'room',
  messages: '[room+order]',
  outbox: 'id, room',
})

const order = (seq: string) => seq.padStart(19, '0')
const history = (room: string) => db.messages.where('[room+order]')
  .between([room, Dexie.minKey], [room, Dexie.maxKey], true, true)

export const roomKey = (identity: Identity, id: string) => `${identity.generation}/${identity.device}/${id}`

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

export function saveEvents(
  room: string,
  device: string,
  expected: Cursor,
  events: WireEvent[],
  boundary: string,
  direction: 'forward' | 'backward',
) {
  const messages = events.map((event) => ({
    room,
    order: order(event.seq),
    seq: event.seq,
    device: event.device_id,
    id: event.client_message_id,
    type: event.content_type,
    text: decodeBody(event),
  }))
  return db.transaction('rw', db.messages, db.cursors, db.outbox, async () => {
    const cursor = await db.cursors.get(room)
    const field = direction === 'forward' ? 'after' : 'before'
    if (!cursor || cursor.floor !== expected.floor || cursor[field] !== expected[field]) return false
    await db.messages.bulkPut(messages)
    const ownIds = messages.filter((item) => item.device === device).map((item) => item.id)
    if (ownIds.length) await db.outbox.where('id').anyOf(ownIds).and((item) => item.room === room).delete()
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

export async function forgetRoom(room: string) {
  await db.transaction('rw', db.messages, db.cursors, db.outbox, async () => {
    await history(room).delete()
    await db.cursors.delete(room)
    await db.outbox.where('room').equals(room).delete()
  })
}
