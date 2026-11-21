import { Hash, Loader2, RefreshCw, Search, TriangleAlert, UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { NavLink } from 'react-router'
import styles from './Sidebar.module.css'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { WaveLine } from './WaveDecor'
import { useChat } from '../chat/chat-context'
import { accountLabel, roomColor, roomTitle } from '../chat/naming'

/** 会话目录：搜索、刷新与当前账号。 */
export function Sidebar() {
  const {
    rooms, roomsError, ready, active, search, setSearch, refresh, status, identity, setWorkspace,
  } = useChat()
  const field = useRef<HTMLInputElement>(null)

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return rooms
    return rooms.filter((room) => {
      const title = roomTitle(room, identity.account).toLowerCase()
      return title.includes(query) || room.conversation_id.toLowerCase().includes(query)
    })
  }, [rooms, search, identity.account])

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
    <section className={styles.sidebar} aria-label="会话列表">
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
                <Button size="icon-sm" variant="default" onClick={() => setWorkspace('new')}
                  aria-label="发起聊天">
                  <UserPlus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>发起聊天</TooltipContent>
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
            placeholder="搜索会话或人名…"
            aria-label="搜索会话或人名"
            className="bg-muted border-transparent pl-9 pr-12 focus-visible:bg-card"
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
            <p className="mt-1 text-xs leading-relaxed">点右上角的人形按钮，按用户名找人开始第一段对话。</p>
          </div>
        ) : visible.length === 0 ? (
          <p className={styles.notice}>没有匹配「{search.trim()}」的会话。</p>
        ) : (
          <nav className={styles.list} aria-label="可访问的会话">
            {visible.map((room) => {
              const selected = active?.conversation_id === room.conversation_id
              return (
                <NavLink
                  key={room.conversation_id}
                  to={`/c/${room.conversation_id}`}
                  className={styles.item}
                  data-active={selected}
                >
                  <span className={styles.tile} style={{ background: roomColor(room.conversation_id) }} aria-hidden="true">
                    〰
                  </span>
                  <div className="min-w-0">
                    <div className={styles.name}>
                      <Hash size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="truncate">{roomTitle(room, identity.account)}</span>
                    </div>
                    <div className={styles.preview} title={room.conversation_id}>{room.conversation_id}</div>
                  </div>
                  <div className={styles.meta}>
                    <span className={styles.time}>#{room.last_seq}</span>
                  </div>
                </NavLink>
              )
            })}
          </nav>
        )}
      </div>

      <div className={styles.device}>
        <span className={styles.deviceAvatar} aria-hidden="true">{(identity.display_name || identity.device).slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-[13px] font-bold">{accountLabel(identity)}</strong>
          <small className={styles.deviceId} title={identity.device}>设备 {identity.device}</small>
        </div>
        <span className={styles.deviceBadge}>{status.state === 'online' ? '在线' : status.state === 'blocked' ? '暂停' : '缓存'}</span>
      </div>
    </section>
  )
}
