import { ArrowLeft, Eye, Info, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useChat } from '../chat/chat-context'
import { roomColor, roomName } from '../chat/naming'

const LABEL = { online: '已连接', offline: '重连中', loading: '同步中', blocked: '同步暂停' } as const

/** 会话头部：标题、同步状态与信息面板开关。 */
export function ChatHeader() {
  const { active, status, closeRoom, refresh, infoOpen, setInfoOpen, retry } = useChat()
  if (!active) return null
  const id = active.conversation_id

  return (
    <header className="shrink-0 border-b border-border bg-card">
      <div className="flex h-[68px] items-center gap-3 px-4 sm:px-5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={closeRoom} aria-label="返回会话列表">
          <ArrowLeft />
        </Button>

        <span
          className="grid size-[42px] shrink-0 place-items-center rounded-[14px] text-lg text-white"
          style={{ background: roomColor(id) }}
          aria-hidden="true"
        >
          〰
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-extrabold tracking-tight">{roomName(id)}</h2>
            <span className="hidden truncate font-mono text-[10px] text-muted-foreground sm:inline" title={id}>
              {id}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs font-semibold text-muted-foreground">
            <Eye size={12} aria-hidden="true" /> 宿主可读 · 最新序号 #{active.last_seq}
          </div>
        </div>

        <span
          className="hidden items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-bold text-muted-foreground sm:inline-flex"
          data-state={status.state}
          role="status"
        >
          <i
            className="size-1.5 rounded-full bg-amber"
            data-state={status.state}
            style={{ background: status.state === 'online' ? 'var(--kelp)' : status.state === 'blocked' ? 'var(--coral)' : 'var(--amber)' }}
            aria-hidden="true"
          />
          {LABEL[status.state]}
        </span>

        <div className="flex items-center gap-0.5">
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
    </header>
  )
}
