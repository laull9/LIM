import { ArrowUp, LogOut, RefreshCw, RotateCcw, X } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Separator } from './ui/separator'
import { WaveStack } from './WaveDecor'
import { useChat } from '../chat/chat-context'
import { accountLabel, roomColor, roomTitle } from '../chat/naming'

const LABEL = { online: '已连接', offline: '离线缓存', loading: '同步中', blocked: '同步暂停' } as const

function Row({ label, value, mono = true, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[11px] font-bold text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[11px] font-semibold ${mono ? 'font-mono' : ''}`}
        title={title ?? value}
      >
        {value}
      </span>
    </div>
  )
}

/** 会话信息面板：展示服务端返回的真实元数据与本地同步游标。 */
export function InfoPanel() {
  const {
    active, identity, status, position, items, canLoadOlder, olderBusy,
    loadOlderMessages, retry, refresh, setInfoOpen, logout,
  } = useChat()
  if (!active) return null
  const id = active.conversation_id
  const ready = items.filter((item) => !('status' in item)).length

  return (
    <aside className="flex w-[320px] shrink-0 animate-in flex-col border-l border-border bg-card fade-in-0 slide-in-from-right-4 duration-200">
      <div className="flex h-[68px] shrink-0 items-center justify-between border-b border-border px-4">
        <h3 className="text-sm font-extrabold">会话信息</h3>
        <Button variant="ghost" size="icon-sm" onClick={() => setInfoOpen(false)} aria-label="关闭信息面板">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative overflow-hidden">
          <WaveStack className="absolute bottom-0 left-0 h-16 w-full" />
          <div className="relative flex flex-col items-center px-5 pb-8 pt-6 text-center">
            <span
              className="grid size-[76px] place-items-center rounded-[24px] text-3xl text-white"
              style={{ background: roomColor(id) }}
              aria-hidden="true"
            >
              〰
            </span>
            <div className="mt-3 text-base font-extrabold">{roomTitle(active, identity.account)}</div>
            <div className="mt-1 break-all px-2 font-mono text-[10px] text-muted-foreground">{id}</div>
            <Badge variant="muted" className="mt-2 gap-1">宿主可读 · host</Badge>
          </div>
        </div>

        <Separator />

        <div className="px-4 py-3">
          <div className="mb-1 text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">服务端</div>
          <Row label="最新序号" value={`#${active.last_seq}`} />
          <Row label="可见起点" value={`#${active.after}`} />
          <Row label="恢复代次" value={identity.generation} title={identity.generation} />
          <Row label="当前账号" value={accountLabel(identity)} mono={false} />
          <Row label="当前设备" value={identity.device} />
        </div>

        <Separator />

        <div className="px-4 py-3">
          <div className="mb-1 text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">本地同步</div>
          <Row label="状态" value={LABEL[status.state]} mono={false} />
          <Row label="已加载消息" value={`${ready} 条`} mono={false} />
          <Row label="本地起点" value={position ? `#${position.floor}` : '—'} />
          <Row label="已补齐至" value={position ? `#${position.after}` : '—'} />
          <Row label="向上边界" value={position ? `#${position.before}` : '—'} />
        </div>

        <Separator />

        <div className="space-y-1.5 p-3">
          <Button variant="secondary" className="w-full justify-start" disabled={!canLoadOlder || olderBusy}
            onClick={loadOlderMessages}>
            <ArrowUp /> {olderBusy ? '正在打捞…' : canLoadOlder ? '加载更早消息' : '已到会话起点'}
          </Button>
          <Button variant="secondary" className="w-full justify-start" onClick={refresh}>
            <RefreshCw /> 刷新会话目录
          </Button>
          <Button variant="secondary" className="w-full justify-start" onClick={retry}>
            <RotateCcw /> 重新同步
          </Button>
        </div>

        <Separator />

        <div className="p-3">
          <Button variant="ghost" className="w-full justify-start text-coral hover:bg-coral/10 hover:text-coral"
            onClick={() => void logout()}>
            <LogOut /> 退出登录
          </Button>
        </div>
      </div>
    </aside>
  )
}
