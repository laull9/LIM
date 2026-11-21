import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMatch, useNavigate } from 'react-router'
import { ChatContext } from './chat-context'
import type { Chat, Item, LightboxMedia, NavKey, Workspace } from './chat-context'
import { clearMediaObjectUrls } from './media'
import { accountLabel } from './naming'
import { explain, LimError, sessionEnded } from './protocol'
import type { Account, Conversation, Identity, LimClient } from './protocol'
import { projectTimeline } from './rich-message'
import type { ProjectedMessage, RichPayload } from './rich-message'
import {
  directoryScope, enqueue, forgetRoom, markFailed, readAllQueued, readDirectory,
  readRoomPreviews, readTimeline, retryPending, roomKey, saveDirectory,
} from './storage'
import type { PendingMessage } from './storage'
import { deliver, loadOlder, synchronizeRoom } from './sync'
import type { SyncStatus } from './sync'

const LOADING: SyncStatus = { state: 'loading' }
const EMPTY_PENDING: PendingMessage[] = []
const EMPTY_PREVIEWS: Record<string, string> = {}
const ENTER_PREF_KEY = 'lim.pref.enterToSend'

function readEnterPref() {
  try {
    return localStorage.getItem(ENTER_PREF_KEY) !== 'false'
  } catch {
    return true
  }
}

/** 真实数据源：会话目录、联系人、本地时间线、富消息归约与服务端同步都收敛在这里。 */
export function ChatProvider({ client, identity, disconnect, onLogout, children }: {
  client: LimClient
  identity: Identity
  disconnect: (issue?: string) => void
  onLogout: () => Promise<void>
  children: ReactNode
}) {
  const navigate = useNavigate()
  const roomId = useMatch('/c/:conversationId')?.params.conversationId
  const scope = directoryScope(identity)
  const room = roomId ? roomKey(identity, roomId) : ''
  const [rooms, setRooms] = useState<Conversation[]>([])
  const [roomsError, setRoomsError] = useState('')
  const [ready, setReady] = useState(false)
  const [nav, setNav] = useState<NavKey>('chats')
  const [workspace, setWorkspace] = useState<Workspace>('none')
  const [search, setSearch] = useState('')
  const [chatSearchState, setChatSearchState] = useState<{ room: string; open: boolean; query: string }>({
    room: '',
    open: false,
    query: '',
  })
  const [infoOpen, setInfoOpen] = useState(false)
  const [replyState, setReplyState] = useState<{ room: string; value: ProjectedMessage | null }>({
    room: '',
    value: null,
  })
  const [lightbox, setLightbox] = useState<LightboxMedia | null>(null)
  const [enterToSend, setEnterToSendState] = useState(readEnterPref)
  const [contacts, setContacts] = useState<Account[]>([])
  const [contactsError, setContactsError] = useState('')
  const [olderBusy, setOlderBusy] = useState(false)
  const [cycle, setCycle] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const delivery = useRef(new Map<string, AbortController>())
  const pumpRef = useRef<() => void>(() => {})
  const remoteLoaded = useRef(false)

  const [sync, setSync] = useState<{ room: string; value: SyncStatus }>({ room: '', value: LOADING })
  const [message, setMessage] = useState<{ room: string; text: string }>({ room: '', text: '' })

  const active = rooms.find((entry) => entry.conversation_id === roomId) ?? null
  const connection = useMemo(
    () => (active ? { client, identity, conversation: active, room } : null),
    [client, identity, active, room],
  )
  const timeline = useLiveQuery(() => (room ? readTimeline(room).catch(() => null) : null), [room])
  const pending = useLiveQuery(() => readAllQueued(scope).catch(() => EMPTY_PENDING), [scope]) ?? EMPTY_PENDING
  const previews = useLiveQuery(() => readRoomPreviews(scope).catch(() => EMPTY_PREVIEWS), [scope]) ?? EMPTY_PREVIEWS

  const pendingRef = useRef<PendingMessage[]>(pending)
  const roomsRef = useRef(rooms)
  const clientRef = useRef(client)
  const identityRef = useRef(identity)

  const status: SyncStatus = sync.room === room ? sync.value : LOADING
  const verified = sync.room === room && sync.value.state === 'online'
  const issue = message.room === room ? message.text : ''
  const storageIssue = timeline === null ? '浏览器无法读取本地消息存储。' : ''
  const timelineReady = timeline !== undefined && timeline !== null && Boolean(room)

  const chatSearchOpen = chatSearchState.room === room && chatSearchState.open
  const chatSearch = chatSearchState.room === room ? chatSearchState.query : ''
  const replyTo = replyState.room === room ? replyState.value : null

  const setChatSearchOpen = useCallback((open: boolean) => {
    setChatSearchState((prev) => ({
      room,
      open,
      query: prev.room === room ? prev.query : '',
    }))
  }, [room])

  const setChatSearch = useCallback((query: string) => {
    setChatSearchState((prev) => ({
      room,
      open: prev.room === room ? prev.open : true,
      query,
    }))
  }, [room])

  const setReplyTo = useCallback((value: ProjectedMessage | null) => {
    setReplyState({ room, value })
  }, [room])

  const setEnterToSend = useCallback((value: boolean) => {
    setEnterToSendState(value)
    try {
      localStorage.setItem(ENTER_PREF_KEY, value ? 'true' : 'false')
    } catch {
      // 忽略禁用存储的浏览器环境。
    }
  }, [])

  /* ── 本地目录：冷启动先显示已经验证过的会话，网络恢复后再对账 ── */
  useEffect(() => {
    let cancelled = false
    remoteLoaded.current = false
    void readDirectory(scope)
      .then((cached) => {
        if (!cancelled && !remoteLoaded.current) {
          setRooms(cached)
          setReady(true)
        }
      })
      .catch(() => {
        if (!cancelled) setReady(true)
      })
    return () => { cancelled = true }
  }, [scope])

  const refreshContacts = useCallback(async () => {
    const current = new AbortController()
    try {
      const result = await clientRef.current.listContacts(identityRef.current.generation, current.signal)
      setContacts(result.contacts)
      setContactsError('')
    } catch (error) {
      if (sessionEnded(error)) disconnect(explain(error))
      else setContactsError(explain(error))
    }
  }, [disconnect])

  /* ── 目录与联系人：30 秒轮询，页面可见与恢复联网时立即对账 ── */
  useEffect(() => {
    const current = new AbortController()
    const { signal } = current
    let running = false
    async function load() {
      if (running || signal.aborted) return
      running = true
      try {
        const [list, contactReply] = await Promise.all([
          client.conversations(identity.generation, signal),
          client.listContacts(identity.generation, signal).catch(() => null),
        ])
        if (!signal.aborted) {
          remoteLoaded.current = true
          setRooms(list)
          setRoomsError('')
          setReady(true)
          if (contactReply) {
            setContacts(contactReply.contacts)
            setContactsError('')
          }
          void saveDirectory(scope, list).catch(() => {
            setMessage({ room, text: '浏览器无法保存会话目录缓存。' })
          })
        }
      } catch (error) {
        if (signal.aborted) return
        if (sessionEnded(error)) disconnect(explain(error))
        else {
          setRoomsError(explain(error))
          setReady(true)
        }
      } finally {
        running = false
      }
    }
    const whenVisible = () => { if (document.visibilityState === 'visible') void load() }
    void load()
    const interval = window.setInterval(whenVisible, 30_000)
    document.addEventListener('visibilitychange', whenVisible)
    window.addEventListener('online', whenVisible)
    return () => {
      current.abort()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', whenVisible)
      window.removeEventListener('online', whenVisible)
    }
  }, [client, identity.generation, disconnect, cycle, room, scope])

  const fail = useCallback((error: unknown, targetRoom: string) => {
    if (sessionEnded(error)) {
      disconnect(explain(error))
      return
    }
    if (error instanceof LimError && error.kind === 'not_found_or_forbidden') {
      controller.current?.abort()
      setSync({ room: targetRoom, value: { state: 'blocked', detail: error.message } })
      setMessage({ room: targetRoom, text: error.message })
      if (targetRoom) {
        void forgetRoom(targetRoom).catch(() => setMessage({ room: targetRoom, text: '浏览器无法清理该会话的本地数据。' }))
      }
    }
  }, [disconnect])

  const globalFail = useCallback((error: unknown, targetRoom: string) => {
    if (sessionEnded(error)) {
      disconnect(explain(error))
      return
    }
    if (error instanceof LimError && error.kind === 'not_found_or_forbidden') {
      const text = explain(error)
      void Promise.all(pendingRef.current
        .filter((item) => item.room === targetRoom && item.status === 'queued')
        .map((item) => markFailed(item.id, text)))
    }
  }, [disconnect])

  /* ── 会话：先补齐历史，再长轮询等待新消息 ── */
  useEffect(() => {
    if (!connection) return
    const current = new AbortController()
    controller.current = current
    void synchronizeRoom(connection, current.signal, (value) => {
      setSync({ room: connection.room, value })
    }, (error) => fail(error, connection.room)).catch((error: unknown) => {
      if (current.signal.aborted) return
      const text = explain(error)
      setSync({ room: connection.room, value: { state: 'blocked', detail: text } })
      setMessage({ room: connection.room, text })
    })
    return () => current.abort()
  }, [connection, fail, cycle])

  /* ── 全局待发队列：不依赖当前打开的会话，每个房间独立串行投递 ── */
  const pump = useCallback(() => {
    if (!ready || navigator.onLine === false) return
    const controllers = delivery.current
    const firstByRoom = new Map<string, PendingMessage>()
    for (const item of pendingRef.current) {
      if (item.status === 'queued' && !firstByRoom.has(item.room)) {
        firstByRoom.set(item.room, item)
      }
    }
    for (const [key, existing] of controllers) {
      if (!firstByRoom.has(key)) {
        existing.abort()
        controllers.delete(key)
      }
    }
    for (const [key, item] of firstByRoom) {
      if (controllers.has(key)) continue
      const conversation = roomsRef.current.find(
        (entry) => roomKey(identityRef.current, entry.conversation_id) === key,
      )
      if (!conversation) continue
      const current = new AbortController()
      controllers.set(key, current)
      void deliver({
        client: clientRef.current,
        identity: identityRef.current,
        conversation,
        room: key,
      }, item, current.signal,
      (error) => globalFail(error, key))
        .catch((error: unknown) => {
          if (!current.signal.aborted) globalFail(error, key)
        })
        .finally(() => {
          if (controllers.get(key) === current) {
            controllers.delete(key)
            pumpRef.current()
          }
        })
    }
  }, [ready, globalFail])
  useEffect(() => {
    pendingRef.current = pending
    roomsRef.current = rooms
    clientRef.current = client
    identityRef.current = identity
    pumpRef.current = pump
    pump()
  }, [pending, rooms, client, identity, pump, cycle, ready])
  useEffect(() => {
    const online = () => pumpRef.current()
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [])
  useEffect(() => () => {
    delivery.current.forEach((current) => current.abort())
    delivery.current.clear()
  }, [scope])

  const loadOlderMessages = useCallback(() => {
    const signal = controller.current?.signal
    if (!connection || olderBusy || !signal || signal.aborted) return
    setOlderBusy(true)
    setMessage({ room: connection.room, text: '' })
    void loadOlder(connection, signal)
      .catch((error: unknown) => {
        if (signal.aborted) return
        fail(error, connection.room)
        setMessage({ room: connection.room, text: explain(error) })
      })
      .finally(() => setOlderBusy(false))
  }, [connection, olderBusy, fail])

  const send = useCallback(async (text: string) => {
    if (!room) throw new Error('尚未选择会话')
    if (replyTo?.seq) {
      const payload: RichPayload = {
        v: 1,
        lim_msg: true,
        kind: 'text',
        text,
        replyTo: {
          seq: replyTo.seq,
          sender: replyTo.senderName,
          preview: replyTo.text.slice(0, 80) || '[富媒体消息]',
        },
        ts: Date.now(),
      }
      await enqueue(room, JSON.stringify(payload), 'application/json')
      setReplyTo(null)
    } else {
      await enqueue(room, text, 'text/plain')
    }
    pumpRef.current()
  }, [room, replyTo, setReplyTo])

  const sendRich = useCallback(async (payload: RichPayload) => {
    if (!room) throw new Error('尚未选择会话')
    const withTime = { ...payload, ts: payload.ts ?? Date.now() }
    await enqueue(room, JSON.stringify(withTime), 'application/json')
    if (payload.kind !== 'reaction' && payload.kind !== 'poll_vote' && payload.kind !== 'pin' && payload.kind !== 'recall') {
      setReplyTo(null)
    }
    pumpRef.current()
  }, [room, setReplyTo])

  const items = useMemo<Item[]>(
    () => (timeline ? [...timeline.messages, ...timeline.pending] : []),
    [timeline],
  )
  const ownDisplayName = accountLabel(identity)
  const projected = useMemo(
    () => projectTimeline(items, identity.account, identity.device, ownDisplayName),
    [items, identity.account, identity.device, ownDisplayName],
  )

  const toggleReaction = useCallback(async (targetSeq: string, emoji: string) => {
    if (!room) return
    const target = projected.bySeq.get(targetSeq)
    const hasMine = target?.reactions.some((r) => r.emoji === emoji && r.accounts.includes(identity.account))
    await sendRich({
      v: 1,
      lim_msg: true,
      kind: 'reaction',
      targetSeq,
      emoji,
      op: hasMine ? 'remove' : 'add',
    })
  }, [room, projected.bySeq, identity.account, sendRich])

  const votePoll = useCallback(async (targetSeq: string, option: number) => {
    if (!room) return
    await sendRich({ v: 1, lim_msg: true, kind: 'poll_vote', targetSeq, option })
  }, [room, sendRich])

  const togglePin = useCallback(async (targetSeq: string, pinned: boolean) => {
    if (!room) return
    await sendRich({ v: 1, lim_msg: true, kind: 'pin', targetSeq, pinned })
  }, [room, sendRich])

  const recallMessage = useCallback(async (targetSeq: string) => {
    if (!room) return
    await sendRich({ v: 1, lim_msg: true, kind: 'recall', targetSeq })
  }, [room, sendRich])

  const retryMessage = useCallback(async (id: string) => {
    await retryPending(id)
    pumpRef.current()
  }, [])

  const addContact = useCallback(async (accountId: string) => {
    const result = await client.addContact(identity.generation, accountId, new AbortController().signal)
    setContacts((current) => current.some((item) => item.account === result.contact.account)
      ? current
      : [...current, result.contact].sort((a, b) => a.display_name.localeCompare(b.display_name)))
  }, [client, identity.generation])

  const removeContact = useCallback(async (accountId: string) => {
    await client.removeContact(identity.generation, accountId, new AbortController().signal)
    setContacts((current) => current.filter((item) => item.account !== accountId))
  }, [client, identity.generation])

  const startDirectChat = useCallback(async (accountId: string) => {
    const conversation = await client.startConversation(
      identity.generation, [accountId], undefined, new AbortController().signal,
    )
    setCycle((count) => count + 1)
    setNav('chats')
    navigate(`/c/${conversation.conversation_id}`)
  }, [client, identity.generation, navigate])

  const openSelfChat = useCallback(async () => {
    const existing = roomsRef.current.find((entry) => entry.kind === 'self')
    if (existing) {
      setNav('chats')
      navigate(`/c/${existing.conversation_id}`)
      return
    }
    const created = await client.startConversation(
      identity.generation, [identity.account], undefined, new AbortController().signal,
    )
    setCycle((count) => count + 1)
    setNav('chats')
    navigate(`/c/${created.conversation_id}`)
  }, [client, identity.account, identity.generation, navigate])

  const openSystemChat = useCallback(() => {
    const existing = roomsRef.current.find((entry) => entry.kind === 'system')
    if (existing) {
      setNav('chats')
      navigate(`/c/${existing.conversation_id}`)
    }
  }, [navigate])

  const cursor = timeline?.cursor

  const value: Chat = {
    client,
    identity,
    rooms,
    roomsError,
    ready,
    active,
    items,
    projected,
    previews,
    prepended: cursor?.prepended ?? 0,
    position: cursor ? { floor: cursor.floor, before: cursor.before, after: cursor.after } : null,
    canLoadOlder: Boolean(verified && cursor && cursor.before !== cursor.floor),
    olderBusy,
    status,
    issue: storageIssue || issue || status.detail || '',
    verified,
    timelineReady,
    nav,
    setNav,
    workspace,
    search,
    chatSearchOpen,
    chatSearch,
    infoOpen,
    replyTo,
    lightbox,
    enterToSend,
    contacts,
    contactsError,
    setSearch,
    setChatSearchOpen,
    setChatSearch,
    setInfoOpen,
    setWorkspace,
    setReplyTo,
    setLightbox,
    setEnterToSend,
    refresh: () => setCycle((count) => count + 1),
    refreshContacts,
    addContact,
    removeContact,
    startDirectChat,
    openSelfChat,
    openSystemChat,
    openRoom: (id) => navigate(`/c/${id}`),
    closeRoom: () => navigate('/'),
    loadOlderMessages,
    send,
    sendRich,
    toggleReaction,
    votePoll,
    togglePin,
    recallMessage,
    retryMessage,
    logout: async () => {
      delivery.current.forEach((current) => current.abort())
      delivery.current.clear()
      clearMediaObjectUrls()
      await onLogout()
    },
    retry: () => {
      setSync({ room, value: LOADING })
      setMessage({ room: '', text: '' })
      setCycle((count) => count + 1)
    },
  }

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}
