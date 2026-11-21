import { useCallback, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import { ArrowDown, Loader2 } from 'lucide-react'
import styles from './Message.module.css'
import { MessageBubble } from './MessageBubble'
import { WaveLine } from './WaveDecor'
import { useChat } from '../chat/chat-context'
import type { Item } from '../chat/chat-context'

const START = 1_000_000_000
const THRESHOLD = 66

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
        发送第一条消息。断网时它也会留在本机，联网后按原键继续投递。
      </p>
    </div>
  )
}

const COMPONENTS = { Header: ListHeader, Footer: ListFooter, EmptyPlaceholder }

const itemKey = (value?: Item) => {
  if (!value) return undefined
  if (!('device' in value)) return 'pending'
  return value.account ? `a:${value.account}` : `d:${value.device}`
}

export function MessageList() {
  const {
    items, prepended, canLoadOlder, olderBusy, loadOlderMessages, identity,
    timelineReady, status,
  } = useChat()
  const virtuoso = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)

  const load = useCallback(() => {
    if (!olderBusy) loadOlderMessages()
  }, [olderBusy, loadOlderMessages])

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
        <Virtuoso<Item, ListContext>
          ref={virtuoso}
          className="absolute inset-0"
          data={items}
          context={context}
          firstItemIndex={START - prepended}
          initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
          followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
          atBottomStateChange={setAtBottom}
          atBottomThreshold={THRESHOLD}
          alignToBottom
          increaseViewportBy={{ top: 600, bottom: 300 }}
          computeItemKey={(_index, item) => `${itemKey(item)}:${item.id}`}
          components={COMPONENTS}
          itemContent={(index, item) => {
            const position = index - (START - prepended)
            const prev = items[position - 1]
            const next = items[position + 1]
            const key = itemKey(item)
            const first = itemKey(prev) !== key
            const last = itemKey(next) !== key
            return <MessageBubble item={item} device={identity.device}
              account={identity.account} first={first} last={last} />
          }}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
          <WaveLine className="w-24 text-tide" />
          <p className="text-xs font-bold" role="status">正在读取本机消息…</p>
        </div>
      )}

      {!atBottom && timelineReady && (
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
