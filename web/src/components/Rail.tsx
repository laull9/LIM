import { LogOut, MessageSquare, Moon, RefreshCw, Sun } from 'lucide-react'
import styles from './Rail.module.css'
import { WaveMark } from './WaveDecor'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { useChat } from '../chat/chat-context'
import { useTheme } from '../theme'

const NAV = [
  { key: 'rooms', label: '会话', icon: MessageSquare },
  { key: 'refresh', label: '刷新目录', icon: RefreshCw },
] as const

/** 左侧潮汐导轨：品牌、视图、外观与当前设备。 */
export function Rail({ onDisconnect }: { onDisconnect: () => void }) {
  const { identity, rooms, refresh, status } = useChat()
  const { theme, toggle } = useTheme()

  return (
    <aside className={styles.rail}>
      <div className={`${styles.tide} ${styles.tideBack}`}>
        <svg viewBox="0 0 400 160" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 70 C 60 30, 120 30, 180 70 S 300 110, 400 70 V160 H0 Z" fill="var(--tide)" />
        </svg>
      </div>
      <div className={`${styles.tide} ${styles.tideFront}`}>
        <svg viewBox="0 0 400 160" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 80 C 70 45, 130 45, 200 80 S 330 115, 400 80 V160 H0 Z" fill="var(--tide-2)" />
        </svg>
      </div>

      <WaveMark size={38} />

      <nav className={styles.nav}>
        {NAV.map(({ key, label, icon: Icon }) => {
          const active = key === 'rooms'
          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <button
                  className={styles.navBtn}
                  data-active={active}
                  aria-label={active ? `${label}，共 ${rooms.length} 个` : label}
                  aria-current={active ? 'page' : undefined}
                  onClick={key === 'refresh' ? refresh : undefined}
                >
                  <Icon size={21} strokeWidth={2.1} aria-hidden="true" />
                  {key === 'rooms' && rooms.length > 0 && (
                    <span className={styles.count}>{rooms.length > 99 ? '99+' : rooms.length}</span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          )
        })}
      </nav>

      <div className={styles.bottom}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button className={styles.themeBtn} onClick={toggle}
              aria-label={theme === 'light' ? '切换到涨潮（深色）' : '切换到退潮（浅色）'}>
              {theme === 'light' ? <Moon size={19} aria-hidden="true" /> : <Sun size={19} aria-hidden="true" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{theme === 'light' ? '涨潮 · 深色' : '退潮 · 浅色'}</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={styles.avatarBtn} aria-label="当前设备">
              {identity.device.slice(-2).toUpperCase()}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-60">
            <DropdownMenuLabel className="normal-case tracking-normal text-foreground">
              <span className="block text-sm font-extrabold">当前设备</span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" title={identity.device}>
                {identity.device}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <span className={`size-2 rounded-full ${status.state === 'online' ? 'bg-kelp' : 'bg-amber'}`} />
              {status.state === 'online' ? '已连接' : status.state === 'blocked' ? '同步暂停' : '重连中'}
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <span className="size-2 rounded-full bg-tide" />
              {rooms.length} 个可用会话
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={refresh}>
              <RefreshCw /> 刷新会话目录
            </DropdownMenuItem>
            <DropdownMenuItem danger onSelect={onDisconnect}>
              <LogOut /> 断开设备
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  )
}
