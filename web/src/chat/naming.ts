import type { Conversation, Identity } from './protocol'
import type { SavedMessage } from './storage'

export function roomName(id: string) {
  return `会话 ${id.slice(-6).toUpperCase()}`
}

export function roomTitle(room: Conversation, ownAccount: string) {
  if (room.kind === 'direct') {
    const other = room.members?.find((member) => member.account !== ownAccount)
    if (other) return other.display_name || `@${other.username}`
  }
  if (room.kind === 'group' && room.title) return room.title
  return roomName(room.conversation_id)
}

export function accountLabel(identity: Identity) {
  return identity.display_name || (identity.username ? `@${identity.username}` : `账号 ${identity.account.slice(-6)}`)
}

export function senderLabel(item: SavedMessage) {
  if (item.display_name) return item.display_name
  if (item.username) return `@${item.username}`
  return deviceLabel(item.device)
}

const TILE_COLORS = ['#0f8b8d', '#2f9e6e', '#3d9cc9', '#c25e9e', '#e9a23b', '#5b6cf0']

export function roomColor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 9973
  return TILE_COLORS[hash % TILE_COLORS.length]
}

export function deviceLabel(id: string) {
  return `设备 ${id.slice(-2).toUpperCase()}`
}
