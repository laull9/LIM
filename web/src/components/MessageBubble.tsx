import {
  Bell, Check, CheckCheck, Clock3, Copy, CornerUpLeft, Download, FileText, Film,
  MapPin, Maximize2, MoreHorizontal, Pause, Pin, Play, RotateCcw, SmilePlus,
  Trash2, TriangleAlert,
} from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import styles from './Message.module.css'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useChat } from '../chat/chat-context'
import { downloadMedia, useMediaUrl } from '../chat/media'
import { avatarInitials, roomColor } from '../chat/naming'
import {
  formatBytes, formatClock, formatDuration, QUICK_REACTIONS, summarizeProjected,
} from '../chat/rich-message'
import type { MediaRef, ProjectedMessage } from '../chat/rich-message'

const INLINE_RE = /(\*\*[^*\n]+\*\*|_[^_\n]+_|`[^`\n]+`|@[\u4e00-\u9fa5A-Za-z0-9_]+|https?:\/\/\S+)/g

const EXT_COLOR: Record<string, string> = {
  pdf: '#e4573d',
  json: '#e9a23b',
  xlsx: '#2f9e6e',
  xls: '#2f9e6e',
  csv: '#2f9e6e',
  mp4: '#5b6cf0',
  mov: '#5b6cf0',
  webm: '#5b6cf0',
  fig: '#c25e9e',
  zip: '#8b5a2b',
  md: '#0f8b8d',
}

function RichText({ text, highlight }: { text: string; highlight?: string }) {
  const parts = text.split(INLINE_RE)
  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <strong key={index} className="font-extrabold">{part.slice(2, -2)}</strong>
        }
        if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
          return <em key={index} className="italic">{part.slice(1, -1)}</em>
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return (
            <code key={index} className="rounded bg-black/15 px-1.5 py-0.5 font-mono text-[0.88em]">
              {part.slice(1, -1)}
            </code>
          )
        }
        if (part.startsWith('@')) {
          return <span key={index} className={styles.mention}>{part}</span>
        }
        if (part.startsWith('http://') || part.startsWith('https://')) {
          return (
            <a key={index} href={part} target="_blank" rel="noreferrer" className={styles.link}>
              {part}
            </a>
          )
        }
        if (highlight) {
          const lower = part.toLowerCase()
          const target = highlight.toLowerCase()
          const pos = lower.indexOf(target)
          if (pos >= 0) {
            return (
              <span key={index}>
                {part.slice(0, pos)}
                <mark className="rounded bg-amber/40 px-0.5 text-current">{part.slice(pos, pos + target.length)}</mark>
                {part.slice(pos + target.length)}
              </span>
            )
          }
        }
        return <span key={index}>{part}</span>
      })}
    </>
  )
}

function ImageCell({ roomId, image, onOpen }: { roomId: string; image: MediaRef; onOpen: () => void }) {
  const { url, loading, error } = useMediaUrl(roomId, image.mediaId)
  if (error) {
    return (
      <div className="grid aspect-[16/10] place-items-center bg-muted text-xs font-bold text-muted-foreground">
        图片加载失败
      </div>
    )
  }
  if (!url) {
    return (
      <div className="grid aspect-[16/10] animate-pulse place-items-center bg-muted text-xs font-bold text-muted-foreground">
        {loading ? '正在加载照片…' : '照片'}
      </div>
    )
  }
  return <img src={url} alt={image.name || '照片'} loading="lazy" onClick={onOpen} />
}

function VideoCard({ roomId, video, onExpand, onDownload }: {
  roomId: string
  video: MediaRef
  onExpand: () => void
  onDownload: () => void
}) {
  const { url, loading, error } = useMediaUrl(roomId, video.mediaId)
  return (
    <div className={styles.videoBox}>
      {url ? (
        <video src={url} controls playsInline preload="metadata" className="max-h-[320px] w-full rounded-[12px] bg-black" />
      ) : (
        <div className="grid h-44 w-[300px] place-items-center rounded-[12px] bg-black/75 text-xs font-bold text-white/80">
          <span className="inline-flex items-center gap-1.5">
            <Film size={16} /> {error ? '视频加载失败' : loading ? '正在加载视频…' : video.name}
          </span>
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[11px] font-semibold opacity-80">
        <span className="truncate">{video.name || '视频'} · {formatBytes(video.size)}</span>
        <span className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={onExpand} className="rounded p-1 hover:bg-black/15" aria-label="全屏预览">
            <Maximize2 size={12} />
          </button>
          <button type="button" onClick={onDownload} className="rounded p-1 hover:bg-black/15" aria-label="下载视频">
            <Download size={12} />
          </button>
        </span>
      </div>
    </div>
  )
}

function VoicePlayer({ roomId, voice }: {
  roomId: string
  voice: { mediaId: string; mime: string; duration: number; waveform: number[] }
}) {
  const { url, loading, error } = useMediaUrl(roomId, voice.mediaId)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentSec, setCurrentSec] = useState(0)
  const duration = Math.max(1, voice.duration)
  const bars = voice.waveform.length > 0 ? voice.waveform : Array.from({ length: 28 }, () => 0.35)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => {
      const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration
      setCurrentSec(audio.currentTime)
      setProgress(Math.min(1, audio.currentTime / total))
    }
    const onEnd = () => {
      setPlaying(false)
      setProgress(0)
      setCurrentSec(0)
    }
    const onPause = () => setPlaying(false)
    const onPlay = () => setPlaying(true)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnd)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('play', onPlay)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnd)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('play', onPlay)
    }
  }, [duration, url])

  function togglePlay() {
    const audio = audioRef.current
    if (!audio || !url) return
    if (playing) audio.pause()
    else void audio.play().catch(() => setPlaying(false))
  }

  function seek(ratio: number) {
    const clamped = Math.max(0, Math.min(1, ratio))
    setProgress(clamped)
    const audio = audioRef.current
    if (audio && url) {
      const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration
      audio.currentTime = clamped * total
    }
  }

  return (
    <div className={styles.voice} data-playing={playing}>
      {url && <audio ref={audioRef} src={url} preload="metadata" />}
      <button
        type="button"
        className={styles.playBtn}
        onClick={togglePlay}
        disabled={!url || error}
        aria-label={playing ? '暂停语音' : '播放语音'}
      >
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
      </button>
      <div
        className={styles.wave}
        role="slider"
        aria-label="语音播放进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (rect.width > 0) seek((event.clientX - rect.left) / rect.width)
        }}
      >
        {bars.map((height, index) => (
          <span
            key={index}
            className={styles.bar}
            data-played={index / bars.length <= progress}
            style={{ height: `${Math.max(16, Math.min(100, Math.round(height * 100)))}%` }}
          />
        ))}
      </div>
      <span className="w-10 text-right text-xs font-bold tabular-nums opacity-85">
        {error ? '失败' : loading ? '…' : playing ? formatDuration(currentSec) : formatDuration(duration)}
      </span>
    </div>
  )
}

function SenderBadge({ id, name }: { id: string; name: string }) {
  return (
    <span
      className="grid size-[34px] shrink-0 place-items-center rounded-full text-[11px] font-extrabold text-white select-none"
      style={{ background: roomColor(id) }}
      aria-hidden="true"
    >
      {avatarInitials(name)}
    </span>
  )
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  first,
  last,
  highlighted,
  onJump,
}: {
  msg: ProjectedMessage
  first: boolean
  last: boolean
  highlighted?: boolean
  onJump: (seq: string) => void
}) {
  const {
    client, identity, active, chatSearch, retryMessage, setReplyTo, setLightbox,
    toggleReaction, votePoll, togglePin, recallMessage,
  } = useChat()
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const roomId = active?.conversation_id ?? ''
  const isSystemRoom = active?.kind === 'system'
  const readOnlyRoom = isSystemRoom

  // 系统消息：在系统频道用通知卡片，在普通对话用居中提示条。
  if (msg.kind === 'system' && msg.rich?.kind === 'system') {
    if (isSystemRoom) {
      return (
        <div className="px-6 py-2">
          <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-4 shadow-xs">
            <div className="flex items-center gap-2 text-xs font-extrabold text-coral">
              <span className="grid size-6 place-items-center rounded-lg bg-coral/15"><Bell size={13} /></span>
              <span>{msg.rich.title || '系统消息'}</span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {formatClock(msg.ts)} {msg.seq ? `· #${msg.seq}` : ''}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-foreground">
              <RichText text={msg.rich.text} highlight={chatSearch.trim()} />
            </p>
          </div>
        </div>
      )
    }
    return (
      <div className={styles.system}>
        <span className="rounded-full border border-border bg-card/90 px-3 py-1 text-xs">
          {msg.rich.title ? `${msg.rich.title}：${msg.rich.text}` : msg.rich.text}
        </span>
      </div>
    )
  }

  if (msg.recalled) {
    return (
      <div className={styles.system}>
        <span>{msg.own ? '你撤回了一条消息' : `${msg.senderName} 撤回了一条消息`}</span>
      </div>
    )
  }

  const own = msg.own
  const pendingItem = 'status' in msg.raw ? msg.raw : null
  const isMediaOnly = (msg.kind === 'image' || msg.kind === 'video') && !msg.text
  const mentionedMe = !own && Boolean(identity.username && msg.text.includes(`@${identity.username}`))
    || (!own && Boolean(identity.display_name && msg.text.includes(`@${identity.display_name}`)))

  async function copyText(textToCopy = summarizeProjected(msg)) {
    try {
      await navigator.clipboard.writeText(textToCopy)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  const content = (() => {
    if (msg.rich?.kind === 'image') {
      const images = msg.rich.images
      return (
        <>
          <div className={styles.imgGrid} data-n={Math.min(4, images.length)}>
            {images.slice(0, 4).map((img) => (
              <ImageCell
                key={img.mediaId}
                roomId={roomId}
                image={img}
                onOpen={() => setLightbox({
                  roomId,
                  mediaId: img.mediaId,
                  kind: 'image',
                  name: img.name,
                  mime: img.mime,
                })}
              />
            ))}
          </div>
          {msg.text && (
            <div className="px-2 pb-1 pt-2">
              <RichText text={msg.text} highlight={chatSearch.trim()} />
            </div>
          )}
        </>
      )
    }
    if (msg.rich?.kind === 'video') {
      const video = msg.rich.video
      return (
        <>
          <VideoCard
            roomId={roomId}
            video={video}
            onExpand={() => setLightbox({
              roomId,
              mediaId: video.mediaId,
              kind: 'video',
              name: video.name,
              mime: video.mime,
            })}
            onDownload={() => void downloadMedia(
              () => client.fetchMedia(identity.generation, roomId, video.mediaId, new AbortController().signal),
              video.name,
            )}
          />
          {msg.text && (
            <div className="px-2 pb-1 pt-2">
              <RichText text={msg.text} highlight={chatSearch.trim()} />
            </div>
          )}
        </>
      )
    }
    if (msg.rich?.kind === 'voice') {
      return <VoicePlayer roomId={roomId} voice={msg.rich.voice} />
    }
    if (msg.rich?.kind === 'file') {
      const file = msg.rich.file
      return (
        <div className="min-w-[230px] py-0.5">
          <div className="flex items-center gap-3">
            <span
              className="grid size-11 shrink-0 place-items-center rounded-xl text-white"
              style={{ background: EXT_COLOR[file.ext] ?? '#5c7382' }}
            >
              <FileText size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">{file.name}</div>
              <div className="text-xs font-semibold uppercase opacity-75">
                {file.ext} · {formatBytes(file.size)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void downloadMedia(
                () => client.fetchMedia(identity.generation, roomId, file.mediaId, new AbortController().signal),
                file.name,
              )}
              className={`grid size-8 shrink-0 place-items-center rounded-lg transition-colors ${own ? 'bg-white/20 hover:bg-white/30' : 'bg-muted hover:bg-accent'}`}
              aria-label="下载文件"
            >
              <Download size={15} />
            </button>
          </div>
          {msg.text && <div className="mt-2 text-sm"><RichText text={msg.text} highlight={chatSearch.trim()} /></div>}
        </div>
      )
    }
    if (msg.rich?.kind === 'code') {
      const code = msg.rich.code
      return (
        <>
          {msg.text && <div className="mb-1.5"><RichText text={msg.text} highlight={chatSearch.trim()} /></div>}
          <div className={styles.code}>
            <div className={styles.codeHead}>
              <span>{code.lang || 'code'}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 normal-case tracking-normal hover:text-white"
                onClick={() => void copyText(code.content)}
              >
                <Copy size={11} /> 复制
              </button>
            </div>
            <pre>{code.content}</pre>
          </div>
        </>
      )
    }
    if (msg.rich?.kind === 'location') {
      const loc = msg.rich.location
      return (
        <div className="min-w-[240px]">
          <div className={`relative h-24 overflow-hidden rounded-xl ${own ? 'bg-white/15' : 'bg-accent'}`}>
            <svg viewBox="0 0 260 112" className="absolute inset-0 size-full" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 70 C 40 40, 80 40, 120 70 S 200 100, 260 70 V112 H0 Z" fill="var(--tide)" opacity=".35" />
              <path d="M0 88 C 50 60, 90 60, 140 88 S 220 115, 260 88 V112 H0 Z" fill="var(--tide)" opacity=".5" />
              <path d="M0 0 H260 V52 C 200 70, 120 30, 0 60 Z" fill="var(--sand)" opacity=".7" />
            </svg>
            <span className="absolute left-1/2 top-1/2 grid size-9 -translate-x-1/2 -translate-y-[65%] place-items-center rounded-full bg-coral text-white shadow-sm">
              <MapPin size={18} />
            </span>
          </div>
          <div className="px-1 pt-2">
            <div className="text-sm font-extrabold">{loc.name}</div>
            <div className="text-xs opacity-75">{loc.address}</div>
            {loc.lat !== undefined && loc.lng !== undefined && (
              <div className="mt-0.5 font-mono text-[10px] opacity-65">
                {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
              </div>
            )}
          </div>
        </div>
      )
    }
    if (msg.rich?.kind === 'poll') {
      const poll = msg.rich.poll
      let totalVotes = 0
      for (const voters of msg.pollVotes.values()) totalVotes += voters.length
      return (
        <div className="min-w-[250px]">
          <div className="text-[10px] font-extrabold uppercase tracking-wider opacity-75">投票</div>
          <div className="mb-2 mt-0.5 text-sm font-extrabold">{poll.question}</div>
          <div className="space-y-1.5">
            {poll.options.map((opt, idx) => {
              const voters = msg.pollVotes.get(idx) ?? []
              const pct = totalVotes > 0 ? Math.round((voters.length / totalVotes) * 100) : 0
              const mine = voters.includes(identity.account)
              return (
                <button
                  key={idx}
                  type="button"
                  disabled={!msg.seq || readOnlyRoom}
                  className={styles.pollOpt}
                  style={{ ['--w' as string]: `${pct}%` }}
                  onClick={() => { if (msg.seq) void votePoll(msg.seq, idx) }}
                >
                  <span className={styles.pollFill} />
                  <span className="relative flex items-center gap-1.5">
                    {mine && <Check size={13} strokeWidth={3} />}
                    {opt}
                  </span>
                  <span className="relative text-xs font-extrabold tabular-nums">{pct}%</span>
                </button>
              )
            })}
          </div>
          <div className="mt-2 text-[11px] opacity-75">{totalVotes} 票 · 点击选项实时投票</div>
        </div>
      )
    }
    return <RichText text={msg.text} highlight={chatSearch.trim()} />
  })()

  return (
    <div
      className={styles.row}
      data-own={own}
      data-first={first}
      data-last={last}
      data-highlighted={highlighted || undefined}
    >
      <div className={styles.avatarSlot}>
        {!own && last && <SenderBadge id={msg.senderId} name={msg.senderName} />}
      </div>

      <div className={styles.body}>
        {!own && first && (
          <div className={styles.sender} style={{ color: roomColor(msg.senderId) }}>
            {msg.senderName}
          </div>
        )}

        <div
          className={styles.bubble}
          data-json={msg.kind === 'raw_json'}
          data-media={isMediaOnly}
          data-mention={mentionedMe}
        >
          {msg.pinned && (
            <span className="absolute -right-1 -top-2 grid size-5 place-items-center rounded-full bg-amber text-white shadow-xs">
              <Pin size={10} className="rotate-45" />
            </span>
          )}
          {msg.replyTo && (
            <button
              type="button"
              className={styles.quote}
              onClick={() => onJump(msg.replyTo!.seq)}
            >
              <div className={styles.quoteName}>{msg.replyTo.sender} · #{msg.replyTo.seq}</div>
              <div className={styles.quoteText}>{msg.replyTo.preview}</div>
            </button>
          )}
          {content}
        </div>

        {msg.reactions.length > 0 && (
          <div className={styles.reactions}>
            {msg.reactions.map((reaction) => {
              const mine = reaction.accounts.includes(identity.account)
              return (
                <Tooltip key={reaction.emoji}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={styles.reaction}
                      data-mine={mine}
                      disabled={!msg.seq || readOnlyRoom}
                      onClick={() => { if (msg.seq) void toggleReaction(msg.seq, reaction.emoji) }}
                    >
                      <span>{reaction.emoji}</span>
                      <span>{reaction.accounts.length}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{reaction.names.join('、')}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        )}

        {last && (
          <div className={styles.meta}>
            {pendingItem ? (
              <>
                {pendingItem.status === 'accepted' ? <Check size={12} aria-hidden="true" />
                  : pendingItem.status === 'failed' ? <TriangleAlert size={12} aria-hidden="true" />
                    : <Clock3 size={12} aria-hidden="true" />}
                <span data-failed={pendingItem.status === 'failed'}>
                  {pendingItem.status === 'accepted' ? '已发送' : pendingItem.status === 'failed' ? pendingItem.issue ?? '发送失败' : '发送中'}
                </span>
                {pendingItem.status === 'failed' && (
                  <button type="button" className="ml-1 inline-flex items-center gap-1 font-bold text-tide"
                    onClick={() => void retryMessage(pendingItem.id)}>
                    <RotateCcw size={11} aria-hidden="true" /> 重试
                  </button>
                )}
              </>
            ) : (
              <>
                <span>{formatClock(msg.ts)}</span>
                <span>· #{msg.seq}</span>
                {own && <CheckCheck size={12} className="text-kelp" aria-hidden="true" />}
              </>
            )}
          </div>
        )}
      </div>

      {!pendingItem && (
        <div className={styles.actions} data-open={menuOpen}>
          {!readOnlyRoom && msg.seq && (
            <>
              <Popover onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <button className={styles.actionBtn} type="button" aria-label="添加反应">
                    <SmilePlus size={15} />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="flex w-auto gap-0.5 p-1.5" side="top">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="grid size-8 place-items-center rounded-lg text-lg transition-transform hover:scale-125 hover:bg-accent"
                      onClick={() => {
                        void toggleReaction(msg.seq!, emoji)
                        setMenuOpen(false)
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button className={styles.actionBtn} type="button" onClick={() => setReplyTo(msg)} aria-label="回复消息">
                    <CornerUpLeft size={15} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>回复</TooltipContent>
              </Tooltip>
            </>
          )}

          <DropdownMenu onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button className={styles.actionBtn} type="button" aria-label="更多操作">
                <MoreHorizontal size={15} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={own ? 'end' : 'start'} className="w-40">
              {!readOnlyRoom && msg.seq && (
                <DropdownMenuItem onSelect={() => setReplyTo(msg)}>
                  <CornerUpLeft /> 回复
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void copyText()}>
                {copied ? <Check /> : <Copy />} {copied ? '已复制' : '复制内容'}
              </DropdownMenuItem>
              {!readOnlyRoom && msg.seq && (
                <DropdownMenuItem onSelect={() => void togglePin(msg.seq!, !msg.pinned)}>
                  <Pin /> {msg.pinned ? '取消置顶' : '置顶消息'}
                </DropdownMenuItem>
              )}
              {own && !readOnlyRoom && msg.seq && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={() => void recallMessage(msg.seq!)}>
                    <Trash2 /> 撤回消息
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
})
