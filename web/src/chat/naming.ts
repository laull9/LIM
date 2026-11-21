import type { Conversation, Identity } from './protocol'
import type { SavedMessage } from './storage'

export function roomName(id: string) {
  return `会话 ${id.slice(-6).toUpperCase()}`
}

export function roomTitle(room: Conversation, ownAccount: string) {
  if (room.kind === 'system') return room.title || '系统消息'
  if (room.kind === 'self') return room.title || '与自己对话'
  if (room.kind === 'direct') {
    const other = room.members?.find((member) => member.account !== ownAccount)
    if (other) return other.display_name || `@${other.username}`
  }
  if (room.kind === 'group' && room.title) return room.title
  return roomName(room.conversation_id)
}

export function roomSubtitle(room: Conversation, ownAccount: string) {
  if (room.kind === 'system') return '系统通知 · 只读频道'
  if (room.kind === 'self') return '私人随手记 · 多设备同步'
  if (room.kind === 'direct') {
    const other = room.members?.find((member) => member.account !== ownAccount)
    if (other) return `@${other.username}`
  }
  if (room.kind === 'group') {
    const count = room.members?.length ?? 0
    return count > 0 ? `${count} 位成员 · 宿主可读` : '小群 · 宿主可读'
  }
  return `宿主可读 · 最新序号 #${room.last_seq}`
}

export function avatarInitials(name: string) {
  const clean = name.trim()
  if (!clean) return 'L'
  if (/^[A-Za-z0-9_ ]+$/.test(clean)) {
    const words = clean.split(/\s+/).filter(Boolean)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    return clean.slice(0, 2).toUpperCase()
  }
  return clean.slice(-1)
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

export function roomColor(id: string, kind?: Conversation['kind']) {
  if (kind === 'system') return '#f26b4e'
  if (kind === 'self') return '#0f8b8d'
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 9973
  return TILE_COLORS[hash % TILE_COLORS.length]
}

export function deviceLabel(id: string) {
  return `设备 ${id.slice(-2).toUpperCase()}`
}
