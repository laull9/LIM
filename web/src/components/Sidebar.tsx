import {
  Bell, Bookmark, Check, Loader2, LogOut, MessageSquarePlus, Monitor, PenLine, RefreshCw,
  Search, TriangleAlert, UserMinus, UserPlus, Users, X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink } from 'react-router'
import styles from './Sidebar.module.css'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { WaveLine } from './WaveDecor'
import { useChat } from '../chat/chat-context'
import { accountLabel, avatarInitials, roomColor, roomTitle } from '../chat/naming'
import { explain } from '../chat/protocol'
import type { Account, Conversation } from '../chat/protocol'
import { roomKey } from '../chat/storage'
import { useTheme } from '../theme'

type Filter = 'all' | 'direct' | 'group'

function readDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function RoomAvatar({ room, ownAccount, size = 44 }: { room: Conversation; ownAccount: string; size?: number }) {
  const title = roomTitle(room, ownAccount)
  const bg = roomColor(room.conversation_id, room.kind)
  return (
    <span
      className={styles.tile}
      style={{ background: bg, width: size, height: size, borderRadius: room.kind === 'direct' ? 999 : 14 }}
      aria-hidden="true"
    >
      {room.kind === 'system' ? <Bell size={Math.round(size * 0.44)} />
        : room.kind === 'self' ? <Bookmark size={Math.round(size * 0.44)} />
          : room.kind === 'group' ? <Users size={Math.round(size * 0.44)} />
            : <span className="text-sm font-extrabold">{avatarInitials(title)}</span>}
    </span>
  )
}

function defaultPreview(room: Conversation) {
  if (room.kind === 'system') return '系统通知与安全提醒'
  if (room.kind === 'self') return '记录文字、语音、照片与文件'
  if (room.kind === 'group') return `${room.members?.length ?? 0} 位成员`
  return '开始这段对话…'
}

function ChatsView() {
  const {
    rooms, roomsError, ready, active, search, setSearch, refresh, status, identity, setWorkspace,
    previews,
  } = useChat()
  const [filter, setFilter] = useState<Filter>('all')
  const field = useRef<HTMLInputElement>(null)

  const ordered = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = rooms.filter((room) => {
      if (filter === 'direct' && room.kind !== 'direct' && room.kind !== 'self') return false
      if (filter === 'group' && room.kind !== 'group') return false
      if (!query) return true
      const title = roomTitle(room, identity.account).toLowerCase()
      const preview = (previews[room.conversation_id] ?? '').toLowerCase()
      return title.includes(query) || preview.includes(query) || room.conversation_id.toLowerCase().includes(query)
    })
    const rank = (kind?: Conversation['kind']) => (kind === 'system' ? 0 : kind === 'self' ? 1 : 2)
    return [...filtered].sort((a, b) => {
      const diff = rank(a.kind) - rank(b.kind)
      if (diff !== 0) return diff
      const seqDiff = BigInt(b.last_seq) - BigInt(a.last_seq)
      if (seqDiff !== 0n) return seqDiff > 0n ? 1 : -1
      return roomTitle(a, identity.account).localeCompare(roomTitle(b, identity.account))
    })
  }, [rooms, filter, search, identity.account, previews])

  const pinnedCount = ordered.filter((room) => room.kind === 'system' || room.kind === 'self').length

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      field.current?.focus()
      field.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const subtitle = roomsError
    ? '目录同步失败 · 显示缓存'
    : status.state === 'offline'
      ? '潮汐暂退 · 正在重连…'
      : rooms.length > 0
        ? '潮汐已同步 · 实时'
        : '暂无会话'

  return (
    <>
      <header className="px-5 pt-5 pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold tracking-tight">消息</h1>
            <p className="mt-0.5 truncate text-xs font-medium text-muted-foreground" data-state={status.state}>
              {subtitle}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="default" onClick={() => setWorkspace('new')} aria-label="发起聊天">
                  <MessageSquarePlus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>发起聊天 / 建群</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="secondary" onClick={refresh} aria-label="刷新会话目录">
                  <RefreshCw />
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新目录</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="relative mt-4">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={field}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索会话、消息…"
            aria-label="搜索会话或人名"
            className="border-transparent bg-muted pl-9 pr-12 focus-visible:bg-card"
          />
          {search ? (
            <button
              className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setSearch('')}
              aria-label="清除搜索"
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] font-bold text-muted-foreground">
              ⌘K
            </kbd>
          )}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="筛选会话">
          {([['all', '全部'], ['direct', '私聊'], ['group', '群组']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
              className={`rounded-lg py-1 text-xs font-bold transition-colors ${filter === key ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {roomsError ? (
          <p role="alert" className={styles.notice}>
            <TriangleAlert size={14} aria-hidden="true" /> {roomsError}
          </p>
        ) : null}
        {!ready ? (
          <p role="status" className={styles.notice}>
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> 正在读取本地目录…
          </p>
        ) : rooms.length === 0 ? (
          <div className={styles.empty}>
            <WaveLine className="mb-3 w-16 text-tide" />
            <p className="text-sm font-semibold">这里风平浪静</p>
            <p className="mt-1 text-xs leading-relaxed">点右上角按钮发起私聊或群组。</p>
          </div>
        ) : ordered.length === 0 ? (
          <p className={styles.notice}>没有匹配的会话。</p>
        ) : (
          <nav className={styles.list} aria-label="可访问的会话">
            {ordered.map((room, index) => {
              const selected = active?.conversation_id === room.conversation_id
              const draft = readDraft(`lim.draft.${roomKey(identity, room.conversation_id)}`).trim()
              const preview = previews[room.conversation_id] || defaultPreview(room)
              return (
                <div key={room.conversation_id}>
                  {index === 0 && pinnedCount > 0 && <div className={styles.sectionLabel}>置顶空间</div>}
                  {index === pinnedCount && pinnedCount > 0 && <div className={styles.sectionLabel}>会话</div>}
                  <NavLink
                    to={`/c/${room.conversation_id}`}
                    className={styles.item}
                    data-active={selected}
                  >
                    <RoomAvatar room={room} ownAccount={identity.account} />
                    <div className="min-w-0">
                      <div className={styles.name}>
                        <span className="truncate">{roomTitle(room, identity.account)}</span>
                        {room.kind === 'system' && (
                          <span className="shrink-0 rounded-full bg-coral/15 px-1.5 py-0.5 text-[10px] font-extrabold text-coral">
                            官方
                          </span>
                        )}
                        {room.kind === 'self' && (
                          <span className="shrink-0 rounded-full bg-tide/15 px-1.5 py-0.5 text-[10px] font-extrabold text-tide">
                            笔记
                          </span>
                        )}
                      </div>
                      <div className={styles.preview} title={draft || preview}>
                        {draft ? (
                          <>
                            <span className="font-bold text-coral">[草稿] </span>
                            {draft}
                          </>
                        ) : preview}
                      </div>
                    </div>
                    <div className={styles.meta}>
                      <span className={styles.time}>#{room.last_seq}</span>
                    </div>
                  </NavLink>
                </div>
              )
            })}
          </nav>
        )}
      </div>
    </>
  )
}

function ContactsView() {
  const {
    client, identity, contacts, contactsError, addContact, removeContact,
    startDirectChat, openSelfChat, openSystemChat, setWorkspace,
  } = useChat()
  const [query, setQuery] = useState('')
  const [remote, setRemote] = useState<Account[]>([])
  const [searching, setSearching] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [issue, setIssue] = useState('')

  const contactIds = useMemo(() => new Set(contacts.map((c) => c.account)), [contacts])

  const localMatches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter((c) => c.display_name.toLowerCase().includes(q) || c.username.toLowerCase().includes(q))
  }, [contacts, query])

  const remoteSuggestions = useMemo(
    () => (query.trim()
      ? remote.filter((u) => u.account !== identity.account && !contactIds.has(u.account))
      : []),
    [query, remote, identity.account, contactIds],
  )

  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSearching(true)
      void client.searchAccounts(identity.generation, q, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setRemote(result.users)
            setIssue('')
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setIssue(explain(error))
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, 220)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [client, identity.generation, query])

  async function onAdd(account: Account) {
    setBusyId(account.account)
    setIssue('')
    try {
      await addContact(account.account)
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setBusyId('')
    }
  }

  async function onRemove(accountId: string) {
    setBusyId(accountId)
    setIssue('')
    try {
      await removeContact(accountId)
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setBusyId('')
    }
  }

  async function onChat(accountId: string) {
    setBusyId(accountId)
    setIssue('')
    try {
      await startDirectChat(accountId)
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setBusyId('')
    }
  }

  return (
    <>
      <header className="px-5 pt-5 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-extrabold tracking-tight">联系人</h1>
            <p className="mt-0.5 text-xs font-medium text-muted-foreground">
              {contacts.length > 0 ? `${contacts.length} 位联系人` : '按用户名或昵称添加好友'}
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="default" onClick={() => setWorkspace('new')} aria-label="创建群聊">
                <Users />
              </Button>
            </TooltipTrigger>
            <TooltipContent>发起群聊</TooltipContent>
          </Tooltip>
        </div>

        <div className="relative mt-4">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索联系人或查找新用户…"
            className="border-transparent bg-muted pl-9 pr-8 focus-visible:bg-card"
          />
          {query && (
            <button
              className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-accent"
              onClick={() => setQuery('')}
              aria-label="清除搜索"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className={styles.sectionLabel}>内置空间</div>
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => void openSelfChat()}
            className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl text-white" style={{ background: '#0f8b8d' }}>
              <Bookmark size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">与自己对话</div>
              <div className="truncate text-xs text-muted-foreground">私人随手记 · 多设备实时同步</div>
            </div>
          </button>
          <button
            type="button"
            onClick={openSystemChat}
            className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl text-white" style={{ background: '#f26b4e' }}>
              <Bell size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">系统消息</div>
              <div className="truncate text-xs text-muted-foreground">登录安全提醒与系统公告</div>
            </div>
          </button>
        </div>

        {(issue || contactsError) && (
          <p role="alert" className="mt-2 px-2 text-xs font-bold text-coral">{issue || contactsError}</p>
        )}

        {query.trim() && (
          <div className="mt-3">
            <div className={styles.sectionLabel}>
              全站用户 {searching ? '· 搜索中…' : ''}
            </div>
            {remoteSuggestions.length === 0 && !searching ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">没有更多可添加的匹配账号。</p>
            ) : (
              <div className="space-y-0.5">
                {remoteSuggestions.map((user) => (
                  <div key={user.account} className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-muted">
                    <span
                      className="grid size-9 shrink-0 place-items-center rounded-full text-xs font-extrabold text-white"
                      style={{ background: roomColor(user.account) }}
                    >
                      {avatarInitials(user.display_name || user.username)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-bold">{user.display_name}</div>
                      <div className="truncate text-xs text-muted-foreground">@{user.username}</div>
                    </div>
                    <Button size="icon-xs" variant="secondary" disabled={busyId === user.account}
                      onClick={() => void onAdd(user)} aria-label="添加联系人">
                      <UserPlus />
                    </Button>
                    <Button size="icon-xs" variant="default" disabled={busyId === user.account}
                      onClick={() => void onChat(user.account)} aria-label="发起私聊">
                      <PenLine />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-3">
          <div className={styles.sectionLabel}>我的联系人 ({localMatches.length})</div>
          {localMatches.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {query.trim() ? '当前联系人中没有匹配项。' : '还没有联系人，在上方输入用户名搜索并添加。'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {localMatches.map((user) => (
                <div key={user.account} className="group flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-muted">
                  <span
                    className="grid size-10 shrink-0 place-items-center rounded-full text-xs font-extrabold text-white"
                    style={{ background: roomColor(user.account) }}
                  >
                    {avatarInitials(user.display_name || user.username)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">{user.display_name}</div>
                    <div className="truncate text-xs text-muted-foreground">@{user.username}</div>
                  </div>
                  <div className="flex gap-1 opacity-80 group-hover:opacity-100">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button size="icon-xs" variant="secondary" disabled={busyId === user.account}
                          onClick={() => void onChat(user.account)} aria-label="发消息">
                          <PenLine />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>发消息</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button size="icon-xs" variant="ghost" disabled={busyId === user.account}
                          onClick={() => void onRemove(user.account)} aria-label="移除联系人"
                          className="text-muted-foreground hover:text-coral">
                          <UserMinus />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>移除</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function SettingsView() {
  const { identity, enterToSend, setEnterToSend, setWorkspace, refresh, logout } = useChat()
  const { theme, toggle } = useTheme()

  return (
    <>
      <header className="px-5 pt-5 pb-3">
        <h1 className="text-xl font-extrabold tracking-tight">设置</h1>
        <p className="mt-0.5 text-xs font-medium text-muted-foreground">外观 · 快捷键 · 设备管理</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex items-center gap-3 rounded-2xl bg-muted p-3">
          <span
            className="grid size-11 shrink-0 place-items-center rounded-full text-sm font-extrabold text-white"
            style={{ background: roomColor(identity.account) }}
          >
            {avatarInitials(identity.display_name || identity.username || identity.device)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-extrabold">{accountLabel(identity)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {identity.username ? `@${identity.username}` : identity.device.slice(0, 12)}
            </div>
          </div>
        </div>

        <div className="mt-5 text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">外观</div>
        <div className="flex items-center justify-between gap-3 py-3">
          <div>
            <div className="text-sm font-bold">潮汐主题</div>
            <div className="text-xs text-muted-foreground">退潮（浅色）/ 涨潮（深色）</div>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
            <button type="button" onClick={() => { if (theme !== 'light') toggle() }}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold ${theme === 'light' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground'}`}>
              退潮
            </button>
            <button type="button" onClick={() => { if (theme !== 'dark') toggle() }}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold ${theme === 'dark' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground'}`}>
              涨潮
            </button>
          </div>
        </div>
        <Separator />

        <div className="mt-4 text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">输入</div>
        <div className="flex items-center justify-between gap-3 py-3">
          <div>
            <div className="text-sm font-bold">Enter 发送消息</div>
            <div className="text-xs text-muted-foreground">关闭后使用 Ctrl/⌘ + Enter 发送</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enterToSend}
            onClick={() => setEnterToSend(!enterToSend)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${enterToSend ? 'bg-tide' : 'bg-muted-foreground/30'}`}
          >
            <span className={`inline-flex size-5 items-center justify-center rounded-full bg-white text-tide shadow-xs transition-transform ${enterToSend ? 'translate-x-5' : 'translate-x-0.5'}`}>
              {enterToSend && <Check size={11} strokeWidth={3} />}
            </span>
          </button>
        </div>
        <Separator />

        <div className="mt-4 space-y-2">
          <Button variant="secondary" className="w-full justify-start" onClick={() => setWorkspace('devices')}>
            <Monitor /> 管理已登录设备
          </Button>
          <Button variant="secondary" className="w-full justify-start" onClick={refresh}>
            <RefreshCw /> 同步会话与联系人
          </Button>
          <Button variant="ghost" className="w-full justify-start text-coral hover:bg-coral/10 hover:text-coral"
            onClick={() => void logout()}>
            <LogOut /> 退出登录
          </Button>
        </div>
      </div>
    </>
  )
}

/** 左侧主面板：根据导轨切换会话目录、联系人与设置。 */
export function Sidebar() {
  const { nav, identity, status } = useChat()

  return (
    <section className={styles.sidebar} aria-label="主导航面板">
      {nav === 'chats' && <ChatsView />}
      {nav === 'contacts' && <ContactsView />}
      {nav === 'settings' && <SettingsView />}

      <div className={styles.device}>
        <span className={styles.deviceAvatar} aria-hidden="true">
          {avatarInitials(identity.display_name || identity.username || identity.device)}
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-[13px] font-bold">{accountLabel(identity)}</strong>
          <small className={styles.deviceId} title={identity.device}>设备 {identity.device}</small>
        </div>
        <span className={styles.deviceBadge}>
          {status.state === 'online' ? '在线' : status.state === 'blocked' ? '暂停' : '缓存'}
        </span>
      </div>
    </section>
  )
}
