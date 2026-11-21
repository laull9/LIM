import { createContext, useContext } from 'react'
import type { Account, Conversation, Identity, LimClient } from './protocol'
import type { PendingMessage, SavedMessage } from './storage'
import type { SyncStatus } from './sync'

export type Item = SavedMessage | PendingMessage
export type Workspace = 'none' | 'new' | 'devices'

export interface Chat {
  client: LimClient
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
  timelineReady: boolean
  workspace: Workspace
  search: string
  infoOpen: boolean
  setSearch: (value: string) => void
  setInfoOpen: (value: boolean) => void
  setWorkspace: (value: Workspace) => void
  refresh: () => void
  openRoom: (id: string) => void
  closeRoom: () => void
  loadOlderMessages: () => void
  send: (text: string) => Promise<void>
  retryMessage: (id: string) => Promise<void>
  logout: () => Promise<void>
  retry: () => void
}

export const ChatContext = createContext<Chat | null>(null)

export function useChat() {
  const value = useContext(ChatContext)
  if (!value) throw new Error('useChat 必须在 ChatProvider 内使用')
  return value
}

export type { Account, Conversation }
