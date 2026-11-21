import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMatch, useNavigate } from 'react-router'
import { ChatContext } from './chat-context'
import type { Chat, Item, Workspace } from './chat-context'
import { explain, LimError, sessionEnded } from './protocol'
import type { Conversation, Identity, LimClient } from './protocol'
import {
  directoryScope, enqueue, forgetRoom, markFailed, readAllQueued, readDirectory,
  readTimeline, retryPending, roomKey, saveDirectory,
} from './storage'
import type { PendingMessage } from './storage'
import { deliver, loadOlder, synchronizeRoom } from './sync'
import type { SyncStatus } from './sync'

const LOADING: SyncStatus = { state: 'loading' }
const EMPTY_PENDING: PendingMessage[] = []

/** 真实数据源：会话目录、本地时间线、全局待发与服务端同步都收敛在这里。 */
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
  const [workspace, setWorkspace] = useState<Workspace>('none')
  const [search, setSearch] = useState('')
  const [infoOpen, setInfoOpen] = useState(false)
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

  const pendingRef = useRef<PendingMessage[]>(pending)
  const roomsRef = useRef(rooms)
  const clientRef = useRef(client)
  const identityRef = useRef(identity)

  const status: SyncStatus = sync.room === room ? sync.value : LOADING
  const verified = sync.room === room && sync.value.state === 'online'
  const issue = message.room === room ? message.text : ''
  const storageIssue = timeline === null ? '浏览器无法读取本地消息存储。' : ''
  const timelineReady = timeline !== undefined && timeline !== null && Boolean(room)

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

  /* ── 目录：30 秒轮询，页面可见与恢复联网时立即对账 ── */
  useEffect(() => {
    const current = new AbortController()
    const { signal } = current
    let running = false
    async function load() {
      if (running || signal.aborted) return
      running = true
      try {
        const list = await client.conversations(identity.generation, signal)
        if (!signal.aborted) {
          remoteLoaded.current = true
          setRooms(list)
          setRoomsError('')
          setReady(true)
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
      void deliver({ client: clientRef.current, identity: identityRef.current,
        conversation, room: key }, item, current.signal,
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
    await enqueue(room, text)
    pumpRef.current()
  }, [room])

  const retryMessage = useCallback(async (id: string) => {
    await retryPending(id)
    pumpRef.current()
  }, [])

  const items = useMemo<Item[]>(
    () => (timeline ? [...timeline.messages, ...timeline.pending] : []),
    [timeline],
  )
  const cursor = timeline?.cursor

  const value: Chat = {
    client,
    identity,
    rooms,
    roomsError,
    ready,
    active,
    items,
    prepended: cursor?.prepended ?? 0,
    position: cursor ? { floor: cursor.floor, before: cursor.before, after: cursor.after } : null,
    canLoadOlder: Boolean(verified && cursor && cursor.before !== cursor.floor),
    olderBusy,
    status,
    issue: storageIssue || issue || status.detail || '',
    verified,
    timelineReady,
    workspace,
    search,
    infoOpen,
    setSearch,
    setInfoOpen,
    setWorkspace,
    refresh: () => setCycle((count) => count + 1),
    openRoom: (id) => navigate(`/c/${id}`),
    closeRoom: () => navigate('/'),
    loadOlderMessages,
    send,
    retryMessage,
    logout: async () => {
      delivery.current.forEach((current) => current.abort())
      delivery.current.clear()
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
