import { ArrowLeft, Bell, Bookmark, Info, RefreshCw, RotateCcw, Search, Users, X } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useChat } from '../chat/chat-context'
import { avatarInitials, roomColor, roomSubtitle, roomTitle } from '../chat/naming'

const LABEL = { online: '已连接', offline: '离线缓存', loading: '同步中', blocked: '同步暂停' } as const

/** 会话头部：专属头像、标题、会话内搜索、同步状态与信息面板开关。 */
export function ChatHeader() {
  const {
    active, identity, status, closeRoom, refresh, infoOpen, setInfoOpen, retry,
    chatSearchOpen, setChatSearchOpen, chatSearch, setChatSearch, projected,
  } = useChat()
  if (!active) return null
  const id = active.conversation_id
  const title = roomTitle(active, identity.account)
  const bg = roomColor(id, active.kind)

  const matchCount = chatSearch.trim()
    ? projected.messages.filter((m) => !m.recalled && m.text.toLowerCase().includes(chatSearch.trim().toLowerCase())).length
    : 0

  return (
    <header className="shrink-0 border-b border-border bg-card">
      <div className="flex h-[68px] items-center gap-3 px-4 sm:px-5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={closeRoom} aria-label="返回会话列表">
          <ArrowLeft />
        </Button>

        <span
          className="grid size-[42px] shrink-0 place-items-center text-white"
          style={{ background: bg, borderRadius: active.kind === 'direct' ? 999 : 14 }}
          aria-hidden="true"
        >
          {active.kind === 'system' ? <Bell size={19} />
            : active.kind === 'self' ? <Bookmark size={19} />
              : active.kind === 'group' ? <Users size={19} />
                : <span className="text-sm font-extrabold">{avatarInitials(title)}</span>}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-extrabold tracking-tight">{title}</h2>
            {active.kind === 'system' && (
              <span className="rounded-full bg-coral/15 px-2 py-0.5 text-[10px] font-extrabold text-coral">
                系统
              </span>
            )}
            {active.kind === 'self' && (
              <span className="rounded-full bg-tide/15 px-2 py-0.5 text-[10px] font-extrabold text-tide">
                随手记
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">
            {roomSubtitle(active, identity.account)} · #{active.last_seq}
          </div>
        </div>

        <span
          className="hidden items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-bold text-muted-foreground sm:inline-flex"
          data-state={status.state}
          role="status"
        >
          <i
            className="size-1.5 rounded-full"
            style={{ background: status.state === 'online' ? 'var(--kelp)' : status.state === 'blocked' ? 'var(--coral)' : 'var(--amber)' }}
            aria-hidden="true"
          />
          {LABEL[status.state]}
        </span>

        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon"
                onClick={() => { setChatSearchOpen(!chatSearchOpen); if (chatSearchOpen) setChatSearch('') }}
                aria-label="在会话中搜索" aria-pressed={chatSearchOpen}
                className={chatSearchOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}>
                <Search className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>搜索聊天记录</TooltipContent>
          </Tooltip>

          {status.state === 'blocked' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={retry} aria-label="重试同步"
                  className="text-muted-foreground hover:text-foreground">
                  <RotateCcw className="size-[18px]" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>重试同步</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={refresh} aria-label="刷新会话目录"
                className="text-muted-foreground hover:text-foreground">
                <RefreshCw className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新目录</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => setInfoOpen(!infoOpen)}
                aria-label="会话信息" aria-pressed={infoOpen}
                className={infoOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}>
                <Info className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>会话信息</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {chatSearchOpen && (
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-4 py-2">
          <Search size={14} className="text-muted-foreground" />
          <Input
            autoFocus
            value={chatSearch}
            onChange={(event) => setChatSearch(event.target.value)}
            placeholder="在当前会话已加载消息中搜索…"
            className="h-8 border-transparent bg-card text-xs"
          />
          {chatSearch.trim() && (
            <span className="shrink-0 text-[11px] font-bold text-muted-foreground">
              {matchCount} 条匹配
            </span>
          )}
          <Button variant="ghost" size="icon-xs" onClick={() => { setChatSearch(''); setChatSearchOpen(false) }} aria-label="关闭搜索">
            <X />
          </Button>
        </div>
      )}
    </header>
  )
}
