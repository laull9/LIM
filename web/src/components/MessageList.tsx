import { useCallback, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import { ArrowDown, Loader2 } from 'lucide-react'
import styles from './Message.module.css'
import { MessageBubble } from './MessageBubble'
import { WaveLine } from './WaveDecor'
import { useChat } from '../chat/chat-context'
import { formatDayDivider, sameCalendarDay } from '../chat/rich-message'
import type { ProjectedMessage } from '../chat/rich-message'

const START = 1_000_000_000
const THRESHOLD = 66
const GROUP_GAP_MS = 5 * 60_000

interface ListContext {
  loading: boolean
  canLoadOlder: boolean
  load: () => void
}

function ListHeader({ context }: { context?: ListContext }) {
  const { loading, canLoadOlder, load } = context!
  return (
    <div className="flex flex-col items-center justify-center py-5 text-muted-foreground">
      {loading ? (
        <span className="inline-flex items-center gap-2 text-xs font-bold">
          <Loader2 size={14} className="animate-spin" /> 正在打捞更早的消息…
        </span>
      ) : canLoadOlder ? (
        <button
          className="text-[11px] font-bold opacity-70 transition-opacity hover:opacity-100"
          onClick={load}
        >
          向上滚动加载更多
        </button>
      ) : (
        <div className="flex flex-col items-center gap-2 py-6">
          <WaveLine className="w-20 text-tide" />
          <span className="text-xs font-bold">这里是潮水的起点 · 没有更早的消息了</span>
        </div>
      )}
    </div>
  )
}

function ListFooter() {
  return <div className="min-h-[44px] px-6 pb-4 pt-2" />
}

function EmptyPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <svg viewBox="0 0 160 80" className="mb-4 w-40" aria-hidden="true">
        <path d="M0 40c13-14 27-14 40 0s27 14 40 0 27-14 40 0 27 14 40 0" fill="none" stroke="var(--tide)" strokeWidth="3" strokeLinecap="round" />
        <path d="M0 58c13-14 27-14 40 0s27 14 40 0 27-14 40 0 27 14 40 0" fill="none" stroke="var(--coral)" strokeWidth="3" strokeLinecap="round" opacity=".8" />
      </svg>
      <h3 className="text-base font-extrabold">新的潮汐，从这里开始</h3>
      <p className="mt-1 max-w-xs text-sm leading-relaxed text-muted-foreground">
        发送文字、语音、照片、视频或文件。断网时消息也会留在本地，联网后自动投递。
      </p>
    </div>
  )
}

const COMPONENTS = { Header: ListHeader, Footer: ListFooter, EmptyPlaceholder }

export function MessageList() {
  const {
    projected, prepended, canLoadOlder, olderBusy, loadOlderMessages,
    timelineReady, status, chatSearch,
  } = useChat()
  const virtuoso = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [flashSeq, setFlashSeq] = useState('')

  const visibleMessages = useMemo(() => {
    const q = chatSearch.trim().toLowerCase()
    if (!q) return projected.messages
    return projected.messages.filter((m) => !m.recalled && m.text.toLowerCase().includes(q))
  }, [projected.messages, chatSearch])

  const load = useCallback(() => {
    if (!olderBusy) loadOlderMessages()
  }, [olderBusy, loadOlderMessages])

  const jumpToSeq = useCallback((seq: string) => {
    const idx = visibleMessages.findIndex((m) => m.seq === seq)
    if (idx < 0) return
    virtuoso.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' })
    setFlashSeq(seq)
    window.setTimeout(() => setFlashSeq((current) => (current === seq ? '' : current)), 1600)
  }, [visibleMessages])

  const context = useMemo<ListContext>(
    () => ({ loading: olderBusy, canLoadOlder, load }),
    [olderBusy, canLoadOlder, load],
  )

  return (
    <div className={styles.canvas}>
      {status.state === 'offline' && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-border bg-card/90 px-3 py-1 text-[11px] font-bold text-muted-foreground shadow-sm">
          离线 · 正在显示本机缓存
        </div>
      )}
      {timelineReady ? (
        <Virtuoso<ProjectedMessage, ListContext>
          ref={virtuoso}
          className="absolute inset-0"
          data={visibleMessages}
          context={context}
          firstItemIndex={START - prepended}
          initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
          followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
          atBottomStateChange={setAtBottom}
          atBottomThreshold={THRESHOLD}
          alignToBottom
          increaseViewportBy={{ top: 600, bottom: 300 }}
          computeItemKey={(_index, item) => `${item.pending ? 'p' : 's'}:${item.id}`}
          components={COMPONENTS}
          itemContent={(index, msg) => {
            const pos = index - (START - prepended)
            const prev = visibleMessages[pos - 1]
            const next = visibleMessages[pos + 1]
            const showDay = !prev || !sameCalendarDay(prev.ts, msg.ts)
            const samePrev = Boolean(
              prev && !showDay && prev.senderId === msg.senderId && prev.kind !== 'system'
              && !prev.recalled && (msg.ts - prev.ts) <= GROUP_GAP_MS,
            )
            const sameNext = Boolean(
              next && sameCalendarDay(msg.ts, next.ts) && next.senderId === msg.senderId
              && next.kind !== 'system' && !next.recalled && (next.ts - msg.ts) <= GROUP_GAP_MS,
            )
            return (
              <>
                {showDay && (
                  <div className={styles.day}>
                    <span className={styles.dayChip}>{formatDayDivider(msg.ts)}</span>
                  </div>
                )}
                <MessageBubble
                  msg={msg}
                  first={!samePrev}
                  last={!sameNext}
                  highlighted={Boolean(msg.seq && msg.seq === flashSeq)}
                  onJump={jumpToSeq}
                />
              </>
            )
          }}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
          <WaveLine className="w-24 text-tide" />
          <p className="text-xs font-bold" role="status">正在读取本机消息…</p>
        </div>
      )}

      {!atBottom && timelineReady && visibleMessages.length > 0 && (
        <button
          className={styles.toBottom}
          onClick={() => virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' })}
        >
          <ArrowDown size={14} /> 回到最新
        </button>
      )}
    </div>
  )
}
