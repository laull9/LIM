/** 会话标题与头像色都由服务端 UUID 派生，不额外保存状态。 */
export function roomName(id: string) {
  return `会话 ${id.slice(-6).toUpperCase()}`
}

const TILE_COLORS = ['#0f8b8d', '#2f9e6e', '#3d9cc9', '#c25e9e', '#e9a23b', '#5b6cf0']

export function roomColor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 9973
  return TILE_COLORS[hash % TILE_COLORS.length]
}

export function deviceLabel(id: string) {
  return `设备 ${id.slice(-6).toUpperCase()}`
}
