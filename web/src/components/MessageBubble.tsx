import { Check, Clock3, Copy, TriangleAlert } from 'lucide-react'
import { memo, useState } from 'react'
import styles from './Message.module.css'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { deviceLabel, roomColor } from '../chat/naming'
import type { Item } from '../chat/chat-context'

const META = /(@[\u4e00-\u9fa5A-Za-z]+|https?:\/\/\S+)/g

/** 纯文本渲染：识别 @提及 与链接，其余原样保留。 */
function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(META).map((part, index) => {
        if (part.startsWith('@')) return <span key={index} className={styles.mention}>{part}</span>
        if (part.startsWith('http')) {
          return (
            <a key={index} href={part} target="_blank" rel="noreferrer" className={styles.link}>
              {part}
            </a>
          )
        }
        return <span key={index}>{part}</span>
      })}
    </>
  )
}

function DeviceBadge({ id }: { id: string }) {
  return (
    <span
      className="grid size-[34px] shrink-0 place-items-center rounded-full text-[11px] font-extrabold text-white select-none"
      style={{ background: roomColor(id) }}
      aria-hidden="true"
    >
      {id.slice(-2).toUpperCase()}
    </span>
  )
}

export const MessageBubble = memo(function MessageBubble({ item, device, first, last }: {
  item: Item
  device: string
  first: boolean
  last: boolean
}) {
  const [copied, setCopied] = useState(false)
  const pending = 'status' in item
  const own = pending || item.device === device
  const sender = pending ? device : item.device
  const json = !pending && item.type === 'application/json'

  async function copy() {
    try {
      await navigator.clipboard.writeText(item.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={styles.row} data-own={own} data-first={first} data-last={last}>
      <div className={styles.avatarSlot}>
        {!own && last && <DeviceBadge id={sender} />}
      </div>

      <div className={styles.body}>
        {!own && first && (
          <div className={styles.sender} style={{ color: roomColor(sender) }}>
            {deviceLabel(sender)}
            {sender === device && <span className="text-[11px] font-semibold text-muted-foreground">本机</span>}
          </div>
        )}

        <div className={styles.bubble} data-json={json}>
          <RichText text={item.text} />
        </div>

        {last && (
          <div className={styles.meta}>
            {pending ? (
              <>
                {item.status === 'accepted' ? <Check size={12} aria-hidden="true" />
                  : item.status === 'failed' ? <TriangleAlert size={12} aria-hidden="true" />
                    : <Clock3 size={12} aria-hidden="true" />}
                <span data-failed={item.status === 'failed'}>
                  {item.status === 'accepted' ? '已发送' : item.status === 'failed' ? item.issue ?? '发送失败' : '等待发送'}
                </span>
              </>
            ) : (
              <span>#{item.seq}</span>
            )}
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button className={styles.actionBtn} onClick={() => void copy()} aria-label="复制消息">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{copied ? '已复制' : '复制'}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})
