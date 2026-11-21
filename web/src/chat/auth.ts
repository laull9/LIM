import { authResult, LimError, refresh } from './protocol'
import type { AuthResult, Identity } from './protocol'

export const AUTH_STORAGE_KEY = 'lim.account.v1'
const DEVICE_STORAGE_KEY = 'lim.device.v1'
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
let memoryDevice = ''

export function identityFromAuth(auth: AuthResult): Identity {
  return {
    generation: auth.generation,
    account: auth.account,
    device: auth.device,
    username: auth.username,
    display_name: auth.display_name,
  }
}

export function loadSavedAuth(): AuthResult | null {
  try {
    const value = localStorage.getItem(AUTH_STORAGE_KEY)
    if (!value) return null
    const parsed = authResult.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function saveAuth(value: AuthResult) {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // 浏览器禁用存储时仍保留当前标签页的内存登录。
  }
}

export function clearSavedAuth(expected?: AuthResult) {
  try {
    const current = loadSavedAuth()
    if (expected && current && current.refresh_token !== expected.refresh_token) return
    localStorage.removeItem(AUTH_STORAGE_KEY)
  } catch {
    // 内存身份仍由调用方清理。
  }
}

export function stableDeviceId() {
  if (memoryDevice) return memoryDevice
  try {
    const saved = localStorage.getItem(DEVICE_STORAGE_KEY)
    if (saved && UUID.test(saved)) {
      memoryDevice = saved
      return saved
    }
    memoryDevice = crypto.randomUUID()
    localStorage.setItem(DEVICE_STORAGE_KEY, memoryDevice)
  } catch {
    memoryDevice = crypto.randomUUID()
  }
  return memoryDevice
}

export function browserDeviceName() {
  const agent = navigator.userAgent
  const browser = /Edg\/[\d.]+/.test(agent) ? 'Edge'
    : /Firefox\/[\d.]+/.test(agent) ? 'Firefox'
      : /Chrome\/[\d.]+/.test(agent) ? 'Chrome'
        : /Safari\/[\d.]+/.test(agent) ? 'Safari' : '浏览器'
  const platform = /iPhone|iPad/.test(agent) ? 'iOS'
    : /Android/.test(agent) ? 'Android'
      : /macOS|Macintosh/.test(agent) ? 'macOS'
        : /Windows/.test(agent) ? 'Windows'
          : /Linux/.test(agent) ? 'Linux' : '未知系统'
  return `${browser} · ${platform}`
}

/** 同源标签页通过 Web Locks 串行轮换，旧 refresh token 不会并发重放。 */
export async function rotateAuth(saved: AuthResult, signal: AbortSignal): Promise<AuthResult> {
  async function rotate() {
    signal.throwIfAborted()
    const latest = loadSavedAuth() ?? saved
    if (latest.account !== saved.account || latest.device !== saved.device) throw new LimError('unauthenticated')
    if (latest.refresh_token !== saved.refresh_token) return latest
    const next = await refresh(saved.refresh_token, signal)
    saveAuth(next)
    return next
  }
  if (navigator.locks) {
    return navigator.locks.request(`lim-auth-refresh:${saved.device}`, { mode: 'exclusive' }, rotate)
  }
  return rotate()
}
