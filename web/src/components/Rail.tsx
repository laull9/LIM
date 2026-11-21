import { Bookmark, LogOut, MessageSquare, Monitor, Moon, RefreshCw, Settings, Sun, Users } from 'lucide-react'
import styles from './Rail.module.css'
import { WaveMark } from './WaveDecor'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { useChat } from '../chat/chat-context'
import type { NavKey } from '../chat/chat-context'
import { useTheme } from '../theme'
import { accountLabel, avatarInitials } from '../chat/naming'

const NAV: { key: NavKey; label: string; icon: typeof MessageSquare }[] = [
  { key: 'chats', label: '会话', icon: MessageSquare },
  { key: 'contacts', label: '联系人', icon: Users },
  { key: 'settings', label: '设置', icon: Settings },
]

/** 左侧潮汐导轨：品牌、视图切换、外观与账号菜单。 */
export function Rail() {
  const {
    identity, rooms, contacts, nav, setNav, refresh, status, setWorkspace, openSelfChat, logout,
  } = useChat()
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
          const active = nav === key
          const count = key === 'chats' ? rooms.length : key === 'contacts' ? contacts.length : 0
          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <button
                  className={styles.navBtn}
                  data-active={active}
                  aria-label={count > 0 ? `${label}，共 ${count} 项` : label}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setNav(key)}
                >
                  <Icon size={21} strokeWidth={2.1} aria-hidden="true" />
                  {count > 0 && (
                    <span className={styles.count}>{count > 99 ? '99+' : count}</span>
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
            <button className={styles.avatarBtn} aria-label="账号与设备">
              {avatarInitials(identity.display_name || identity.username || identity.device)}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-60">
            <DropdownMenuLabel className="normal-case tracking-normal text-foreground">
              <span className="block truncate text-sm font-extrabold">{accountLabel(identity)}</span>
              {identity.username && (
                <span className="block truncate text-xs font-semibold text-muted-foreground">@{identity.username}</span>
              )}
              <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" title={identity.device}>
                设备 {identity.device.slice(0, 12)}…
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <span className={`size-2 rounded-full ${status.state === 'online' ? 'bg-kelp' : 'bg-amber'}`} />
              {status.state === 'online' ? '已连接' : status.state === 'blocked' ? '同步暂停' : '使用本地缓存'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void openSelfChat()}>
              <Bookmark /> 与自己对话
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={refresh}>
              <RefreshCw /> 刷新会话目录
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setWorkspace('devices')}>
              <Monitor /> 账号与设备
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger onSelect={() => void logout()}>
              <LogOut /> 退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  )
}
