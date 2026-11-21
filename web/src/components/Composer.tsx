import { SendHorizontal, Smile } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import styles from './Composer.module.css'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useChat } from '../chat/chat-context'

const MAX_BYTES = 65_536
const EMOJI = ['🌊', '🫧', '🐚', '⛵️', '🌴', '☀️', '🌙', '🐟', '🦀', '💧', '🧭', '🌬️', '👋', '👍', '🎉', '✅']

export function Composer() {
  const { active, verified, send } = useChat()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const bytes = new TextEncoder().encode(value).length
  const oversized = bytes > MAX_BYTES
  const canSend = verified && Boolean(active) && !busy && !oversized && Boolean(value.trim())

  useEffect(() => {
    const element = area.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(180, element.scrollHeight)}px`
  }, [value])

  async function submit() {
    const text = value.trim()
    if (!canSend || !text) return
    setBusy(true)
    setIssue('')
    try {
      await send(value)
      setValue('')
      area.current?.focus()
    } catch {
      setIssue('无法保存待发消息，草稿仍在输入框中。')
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !composing.current && event.keyCode !== 229) {
      event.preventDefault()
      void submit()
    }
  }

  function insert(text: string) {
    const element = area.current
    if (!element) {
      setValue((current) => current + text)
      return
    }
    const start = element.selectionStart ?? value.length
    const end = element.selectionEnd ?? value.length
    setValue(value.slice(0, start) + text + value.slice(end))
    requestAnimationFrame(() => {
      element.focus()
      const caret = start + text.length
      element.setSelectionRange(caret, caret)
    })
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.box}>
        <textarea
          ref={area}
          className={styles.textarea}
          rows={1}
          value={value}
          aria-label="消息正文"
          aria-invalid={oversized || Boolean(issue)}
          placeholder={active ? `发消息到 ${active.conversation_id.slice(-6).toUpperCase()}…` : '选择一个会话开始对话'}
          disabled={!verified || !active}
          onChange={(event) => { setValue(event.target.value); setIssue('') }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
        />
        <div className={styles.toolbar}>
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button className={styles.tool} aria-label="表情" type="button">
                    <Smile size={18} />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>表情</TooltipContent>
            </Tooltip>
            <PopoverContent side="top" align="start" className="w-64 p-2">
              <div className="grid grid-cols-8 gap-0.5">
                {EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="grid size-7 place-items-center rounded-lg text-lg transition-transform hover:scale-110 hover:bg-accent"
                    onClick={() => insert(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          {canSend || busy ? (
            <button className={styles.send} onClick={() => void submit()} disabled={!canSend} type="button">
              <SendHorizontal size={15} /> {busy ? '发送中' : '发送'}
            </button>
          ) : (
            <span className="ml-auto text-[11px] font-semibold text-muted-foreground">
              {oversized ? '超过 64 KiB' : ''}
            </span>
          )}
        </div>
      </div>
      <div className={styles.hint}>
        <span data-error={oversized || Boolean(issue)}>
          {issue || (oversized ? '消息超过 64 KiB，无法发送。' : (
            <>
              <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行
            </>
          ))}
        </span>
        <span>{value.length > 0 && `${value.length} 字`}</span>
      </div>
    </div>
  )
}
