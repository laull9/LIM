import { createContext, useContext } from 'react'
import type { Account, Conversation, Identity, LimClient } from './protocol'
import type { PendingMessage, SavedMessage } from './storage'
import type { SyncStatus } from './sync'
import type { ProjectedMessage, ProjectedTimeline, RichPayload } from './rich-message'

export type Item = SavedMessage | PendingMessage
export type Workspace = 'none' | 'new' | 'devices'
export type NavKey = 'chats' | 'contacts' | 'settings'

export interface LightboxMedia {
  roomId: string
  mediaId: string
  kind: 'image' | 'video'
  name: string
  mime: string
}

export interface Chat {
  client: LimClient
  identity: Identity
  rooms: Conversation[]
  roomsError: string
  ready: boolean
  active: Conversation | null
  items: Item[]
  projected: ProjectedTimeline
  previews: Record<string, string>
  prepended: number
  position: { floor: string; before: string; after: string } | null
  canLoadOlder: boolean
  olderBusy: boolean
  status: SyncStatus
  issue: string
  verified: boolean
  timelineReady: boolean
  nav: NavKey
  setNav: (value: NavKey) => void
  workspace: Workspace
  search: string
  chatSearchOpen: boolean
  chatSearch: string
  infoOpen: boolean
  replyTo: ProjectedMessage | null
  lightbox: LightboxMedia | null
  enterToSend: boolean
  contacts: Account[]
  contactsError: string
  setSearch: (value: string) => void
  setChatSearchOpen: (value: boolean) => void
  setChatSearch: (value: string) => void
  setInfoOpen: (value: boolean) => void
  setWorkspace: (value: Workspace) => void
  setReplyTo: (value: ProjectedMessage | null) => void
  setLightbox: (value: LightboxMedia | null) => void
  setEnterToSend: (value: boolean) => void
  refresh: () => void
  refreshContacts: () => Promise<void>
  addContact: (accountId: string) => Promise<void>
  removeContact: (accountId: string) => Promise<void>
  startDirectChat: (accountId: string) => Promise<void>
  openSelfChat: () => Promise<void>
  openSystemChat: () => void
  openRoom: (id: string) => void
  closeRoom: () => void
  loadOlderMessages: () => void
  send: (text: string) => Promise<void>
  sendRich: (payload: RichPayload) => Promise<void>
  toggleReaction: (targetSeq: string, emoji: string) => Promise<void>
  votePoll: (targetSeq: string, option: number) => Promise<void>
  togglePin: (targetSeq: string, pinned: boolean) => Promise<void>
  recallMessage: (targetSeq: string) => Promise<void>
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
