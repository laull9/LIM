import { createContext, useContext } from 'react'
import type { Conversation, Identity } from './protocol'
import type { PendingMessage, SavedMessage } from './storage'
import type { SyncStatus } from './sync'

export type Item = SavedMessage | PendingMessage

export interface Chat {
  identity: Identity
  rooms: Conversation[]
  roomsError: string
  ready: boolean
  active: Conversation | null
  items: Item[]
  prepended: number
  position: { floor: string; before: string; after: string } | null
  canLoadOlder: boolean
  olderBusy: boolean
  status: SyncStatus
  issue: string
  verified: boolean
  search: string
  infoOpen: boolean
  setSearch: (value: string) => void
  setInfoOpen: (value: boolean) => void
  refresh: () => void
  openRoom: (id: string) => void
  closeRoom: () => void
  loadOlderMessages: () => void
  send: (text: string) => Promise<void>
  retry: () => void
}

export const ChatContext = createContext<Chat | null>(null)

export function useChat() {
  const value = useContext(ChatContext)
  if (!value) throw new Error('useChat 必须在 ChatProvider 内使用')
  return value
}
