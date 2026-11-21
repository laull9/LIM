import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMatch, useNavigate } from 'react-router'
import { ChatContext } from './chat-context'
import type { Chat, Item } from './chat-context'
import { explain, LimError, sessionEnded } from './protocol'
import type { Conversation, Identity, LimClient } from './protocol'
import { enqueue, forgetRoom, readTimeline, roomKey } from './storage'
import { deliver, loadOlder, synchronizeRoom } from './sync'
import type { SyncStatus } from './sync'

const LOADING: SyncStatus = { state: 'loading' }

/** 真实数据源：会话目录、本地时间线与服务端同步都收敛在这里。 */
export function ChatProvider({ client, identity, disconnect, children }: {
  client: LimClient
  identity: Identity
  disconnect: (issue?: string) => void
  children: ReactNode
}) {
  const navigate = useNavigate()
  const roomId = useMatch('/c/:conversationId')?.params.conversationId
  const [rooms, setRooms] = useState<Conversation[]>([])
  const [roomsError, setRoomsError] = useState('')
  const [ready, setReady] = useState(false)
  const [search, setSearch] = useState('')
  const [infoOpen, setInfoOpen] = useState(false)
  const [olderBusy, setOlderBusy] = useState(false)
  const [cycle, setCycle] = useState(0)
  const controller = useRef<AbortController | null>(null)

  // 状态与错误都带上所属会话，切换会话时自然失效，无需在 effect 里重置。
  const [sync, setSync] = useState<{ room: string; value: SyncStatus }>({ room: '', value: LOADING })
  const [message, setMessage] = useState<{ room: string; text: string }>({ room: '', text: '' })

  const active = rooms.find((room) => room.conversation_id === roomId) ?? null
  const room = active ? roomKey(identity, active.conversation_id) : ''
  const connection = useMemo(
    () => (active ? { client, identity, conversation: active, room } : null),
    [client, identity, active, room],
  )
  const timeline = useLiveQuery(() => (room ? readTimeline(room).catch(() => null) : null), [room])

  const status: SyncStatus = sync.room === room ? sync.value : LOADING
  const verified = sync.room === room && sync.value.state === 'online'
  const issue = message.room === room ? message.text : ''
  const waiting = timeline?.pending.find((item) => item.status === 'queued')
  const denied = status.state === 'blocked'
  const storageIssue = timeline === null ? '浏览器无法读取本地消息存储。' : ''

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
          setRooms(list)
          setRoomsError('')
          setReady(true)
        }
      } catch (error) {
        if (signal.aborted) return
        if (sessionEnded(error)) disconnect(explain(error))
        else setRoomsError(explain(error))
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
  }, [client, identity.generation, disconnect, cycle])

  const fail = useCallback((error: unknown) => {
    if (sessionEnded(error)) {
      disconnect(explain(error))
      return
    }
    if (error instanceof LimError && error.kind === 'not_found_or_forbidden') {
      controller.current?.abort()
      setSync({ room, value: { state: 'blocked', detail: error.message } })
      setMessage({ room, text: error.message })
      if (room) {
        void forgetRoom(room).catch(() => setMessage({ room, text: '浏览器无法清理该会话的本地数据。' }))
      }
    }
  }, [disconnect, room])

  /* ── 会话：先补齐历史，再长轮询等待新消息 ── */
  useEffect(() => {
    if (!connection) return
    const current = new AbortController()
    controller.current = current
    void synchronizeRoom(connection, current.signal, (value) => {
      setSync({ room: connection.room, value })
    }, fail).catch((error: unknown) => {
      if (current.signal.aborted) return
      const text = explain(error)
      setSync({ room: connection.room, value: { state: 'blocked', detail: text } })
      setMessage({ room: connection.room, text })
    })
    return () => current.abort()
  }, [connection, fail, cycle])

  /* ── 待发队列：验证通过后按原键与原文重试投递 ── */
  useEffect(() => {
    if (!connection || !verified || denied || !waiting) return
    const current = new AbortController()
    void deliver(connection, waiting, current.signal, fail).catch((error: unknown) => {
      if (current.signal.aborted) return
      const text = explain(error)
      setSync({ room: connection.room, value: { state: 'blocked', detail: text } })
      setMessage({ room: connection.room, text })
    })
    return () => current.abort()
  }, [connection, denied, fail, verified, waiting])

  const loadOlderMessages = useCallback(() => {
    const signal = controller.current?.signal
    if (!connection || olderBusy || !signal || signal.aborted) return
    setOlderBusy(true)
    setMessage({ room: connection.room, text: '' })
    void loadOlder(connection, signal)
      .catch((error: unknown) => {
        if (signal.aborted) return
        fail(error)
        setMessage({ room: connection.room, text: explain(error) })
      })
      .finally(() => setOlderBusy(false))
  }, [connection, olderBusy, fail])

  const send = useCallback(async (text: string) => {
    if (!room) throw new Error('尚未选择会话')
    await enqueue(room, text)
  }, [room])

  const items = useMemo<Item[]>(
    () => (timeline ? [...timeline.messages, ...timeline.pending] : []),
    [timeline],
  )
  const cursor = timeline?.cursor

  const value: Chat = {
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
    search,
    infoOpen,
    setSearch,
    setInfoOpen,
    refresh: () => setCycle((count) => count + 1),
    openRoom: (id) => navigate(`/c/${id}`),
    closeRoom: () => navigate('/'),
    loadOlderMessages,
    send,
    retry: () => {
      setSync({ room, value: LOADING })
      setMessage({ room, text: '' })
      setCycle((count) => count + 1)
    },
  }

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}
