import {
  AtSign, BarChart3, Bell, Bold, Code, CornerUpLeft, FileText, FileUp, Film,
  Image as ImageIcon, Italic, Loader2, LocateFixed, MapPin, Mic, Paperclip, Plus,
  SendHorizontal, Smile, Trash2, X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import styles from './Composer.module.css'
import { Button } from './ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useChat } from '../chat/chat-context'
import { avatarInitials, roomColor, roomTitle } from '../chat/naming'
import { explain, MAX_MEDIA_BYTES } from '../chat/protocol'
import {
  EMOJI_SET, fileExtension, formatBytes, formatDuration, summarizeProjected,
} from '../chat/rich-message'
import type { MediaRef, ReplyRef } from '../chat/rich-message'
import { roomKey } from '../chat/storage'

const MAX_BYTES = 65_536
const EMOJI_TABS = Object.keys(EMOJI_SET)

type DraftAttachment =
  | { kind: 'images'; files: { file: File; previewUrl: string }[] }
  | { kind: 'video'; file: File; previewUrl: string }
  | { kind: 'file'; file: File }

type ModalKind = 'none' | 'code' | 'location' | 'poll'

function readDraft(key: string) {
  if (!key) return ''
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const candidate of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}

function normalizeWaveform(samples: number[], bars = 32) {
  if (samples.length === 0) {
    return Array.from({ length: bars }, (_, i) => {
      const env = Math.sin(((i + 0.5) / bars) * Math.PI)
      return Number(Math.max(0.18, Math.min(0.95, 0.25 + env * 0.55)).toFixed(2))
    })
  }
  const out: number[] = []
  const step = samples.length / bars
  for (let i = 0; i < bars; i += 1) {
    const start = Math.floor(i * step)
    const end = Math.max(start + 1, Math.floor((i + 1) * step))
    let sum = 0
    for (let j = start; j < end && j < samples.length; j += 1) sum += samples[j]
    const avg = sum / Math.max(1, end - start)
    out.push(Number(Math.max(0.14, Math.min(1, avg)).toFixed(2)))
  }
  return out
}

function ToolButton({ label, onClick, disabled, children }: {
  label: string
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className={styles.tool} onClick={onClick} disabled={disabled} aria-label={label} type="button">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function Composer() {
  const {
    client, active, identity, timelineReady, status, enterToSend,
    replyTo, setReplyTo, send, sendRich,
  } = useChat()
  const roomId = active?.conversation_id ?? ''
  const key = active ? `lim.draft.${roomKey(identity, roomId)}` : ''
  const [value, setValue] = useState(() => readDraft(key))
  const [emojiTab, setEmojiTab] = useState(EMOJI_TABS[0])
  const [mentionOpen, setMentionOpen] = useState(false)
  const [attachment, setAttachment] = useState<DraftAttachment | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState('')

  // 语音录制状态
  const [recording, setRecording] = useState(false)
  const [recSec, setRecSec] = useState(0)
  const [liveBars, setLiveBars] = useState<number[]>(() => Array.from({ length: 28 }, () => 0.25))
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const samplesRef = useRef<number[]>([])
  const chunksRef = useRef<Blob[]>([])
  const recStartRef = useRef(0)
  const sampleTimerRef = useRef<number | null>(null)
  const cancelledRecRef = useRef(false)

  // 富消息弹窗状态
  const [modal, setModal] = useState<ModalKind>('none')
  const [codeLang, setCodeLang] = useState('tsx')
  const [codeBody, setCodeBody] = useState('')
  const [codeNote, setCodeNote] = useState('')
  const [locName, setLocName] = useState('')
  const [locAddr, setLocAddr] = useState('')
  const [locCoords, setLocCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [locating, setLocating] = useState(false)
  const [pollQuestion, setPollQuestion] = useState('')
  const [pollOptions, setPollOptions] = useState(['', ''])

  const area = useRef<HTMLTextAreaElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const videoInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const composing = useRef(false)

  const bytes = new TextEncoder().encode(value).length
  const oversized = bytes > MAX_BYTES
  const hasContent = Boolean(value.trim()) || Boolean(attachment)
  const canSend = timelineReady && Boolean(active) && active?.kind !== 'system' && !busy && !oversized && hasContent

  const members = (active?.members ?? []).filter((member) => member.account !== identity.account)

  useEffect(() => {
    if (!key) return
    try {
      if (value) localStorage.setItem(key, value)
      else localStorage.removeItem(key)
    } catch {
      // 浏览器禁用存储时草稿只保留在当前输入框。
    }
  }, [key, value])

  useEffect(() => {
    const element = area.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(180, element.scrollHeight)}px`
  }, [value])

  useEffect(() => {
    if (replyTo) area.current?.focus()
  }, [replyTo])

  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => {
      setRecSec(Math.floor((Date.now() - recStartRef.current) / 1000))
    }, 300)
    return () => window.clearInterval(timer)
  }, [recording])

  function cleanupAttachment(current: DraftAttachment | null) {
    if (!current) return
    if (current.kind === 'images') {
      current.files.forEach((entry) => URL.revokeObjectURL(entry.previewUrl))
    } else if (current.kind === 'video') {
      URL.revokeObjectURL(current.previewUrl)
    }
  }

  function replaceAttachment(next: DraftAttachment | null) {
    setAttachment((prev) => {
      cleanupAttachment(prev)
      return next
    })
  }

  function teardownRecorder() {
    if (sampleTimerRef.current !== null) {
      window.clearInterval(sampleTimerRef.current)
      sampleTimerRef.current = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    recorderRef.current = null
  }

  useEffect(() => () => {
    teardownRecorder()
  }, [])

  function currentReplyRef(): ReplyRef | undefined {
    if (!replyTo?.seq) return undefined
    return {
      seq: replyTo.seq,
      sender: replyTo.senderName,
      preview: summarizeProjected(replyTo).slice(0, 80),
    }
  }

  function stageFiles(fileList: FileList | File[], preferred?: 'image' | 'video' | 'file') {
    const list = Array.from(fileList)
    if (list.length === 0) return
    for (const file of list) {
      if (file.size === 0) {
        setIssue(`文件「${file.name}」为空，无法发送。`)
        return
      }
      if (file.size > MAX_MEDIA_BYTES) {
        setIssue(`「${file.name}」超过 20 MB 上限。`)
        return
      }
    }
    setIssue('')
    const first = list[0]
    const isImages = preferred === 'image' || (!preferred && list.every((file) => file.type.startsWith('image/')))
    if (isImages) {
      const picked = list.slice(0, 4).map((file) => ({ file, previewUrl: URL.createObjectURL(file) }))
      replaceAttachment({ kind: 'images', files: picked })
      return
    }
    const isVideo = preferred === 'video' || (!preferred && first.type.startsWith('video/'))
    if (isVideo) {
      replaceAttachment({ kind: 'video', file: first, previewUrl: URL.createObjectURL(first) })
      return
    }
    replaceAttachment({ kind: 'file', file: first })
  }

  async function submit() {
    if (!canSend || !active) return
    const text = value.trim()
    setBusy(true)
    setIssue('')
    try {
      if (!attachment) {
        if (!text) return
        await send(value)
        setValue('')
        area.current?.focus()
        return
      }

      const signal = new AbortController().signal
      const reply = currentReplyRef()
      if (attachment.kind === 'images') {
        const uploaded: MediaRef[] = []
        for (let i = 0; i < attachment.files.length; i += 1) {
          const file = attachment.files[i].file
          const meta = await client.uploadMedia(
            identity.generation, roomId, file, file.name || `photo-${i + 1}.png`,
            file.type || 'image/png', signal,
            (pct) => setUploadProgress(Math.round(((i + pct / 100) / attachment.files.length) * 100)),
          )
          uploaded.push({
            mediaId: meta.media_id,
            mime: meta.mime_type,
            name: meta.filename || file.name,
            size: meta.size,
          })
        }
        await sendRich({
          v: 1,
          lim_msg: true,
          kind: 'image',
          images: uploaded,
          ...(text ? { text } : {}),
          ...(reply ? { replyTo: reply } : {}),
        })
      } else if (attachment.kind === 'video') {
        const file = attachment.file
        const meta = await client.uploadMedia(
          identity.generation, roomId, file, file.name || 'video.mp4',
          file.type || 'video/mp4', signal,
          (pct) => setUploadProgress(pct),
        )
        await sendRich({
          v: 1,
          lim_msg: true,
          kind: 'video',
          video: {
            mediaId: meta.media_id,
            mime: meta.mime_type,
            name: meta.filename || file.name,
            size: meta.size,
          },
          ...(text ? { text } : {}),
          ...(reply ? { replyTo: reply } : {}),
        })
      } else {
        const file = attachment.file
        const meta = await client.uploadMedia(
          identity.generation, roomId, file, file.name || 'file',
          file.type || 'application/octet-stream', signal,
          (pct) => setUploadProgress(pct),
        )
        await sendRich({
          v: 1,
          lim_msg: true,
          kind: 'file',
          file: {
            mediaId: meta.media_id,
            mime: meta.mime_type,
            name: meta.filename || file.name,
            size: meta.size,
            ext: fileExtension(file.name, meta.mime_type),
          },
          ...(text ? { text } : {}),
          ...(reply ? { replyTo: reply } : {}),
        })
      }
      replaceAttachment(null)
      setValue('')
      area.current?.focus()
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setUploadProgress(null)
      setBusy(false)
    }
  }

  async function startRecording() {
    if (!active || busy) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setIssue('当前浏览器不支持麦克风录音，请使用现代浏览器或 HTTPS / localhost 访问。')
      return
    }
    setIssue('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = pickAudioMime()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      recorderRef.current = recorder
      chunksRef.current = []
      samplesRef.current = []
      cancelledRecRef.current = false
      recStartRef.current = Date.now()

      try {
        const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new AudioCtor()
        audioCtxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        const data = new Uint8Array(analyser.frequencyBinCount)
        sampleTimerRef.current = window.setInterval(() => {
          analyser.getByteTimeDomainData(data)
          let sum = 0
          for (let i = 0; i < data.length; i += 1) {
            const norm = (data[i] - 128) / 128
            sum += norm * norm
          }
          const rms = Math.sqrt(sum / data.length)
          const level = Math.max(0.14, Math.min(1, rms * 3.8 + 0.14))
          samplesRef.current.push(level)
          setLiveBars((prev) => [...prev.slice(1), level])
        }, 90)
      } catch {
        // AudioContext 受限时退回平稳波形。
      }

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const duration = Math.max(1, Math.round((Date.now() - recStartRef.current) / 1000))
        const waveform = normalizeWaveform(samplesRef.current, 32)
        const mime = recorder.mimeType || mimeType || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type: mime })
        teardownRecorder()
        setRecording(false)
        if (cancelledRecRef.current || blob.size === 0) return

        setBusy(true)
        setIssue('')
        void (async () => {
          try {
            const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'
            const meta = await client.uploadMedia(
              identity.generation, roomId, blob, `voice-${Date.now()}.${ext}`, mime,
              new AbortController().signal, (pct) => setUploadProgress(pct),
            )
            const reply = currentReplyRef()
            await sendRich({
              v: 1,
              lim_msg: true,
              kind: 'voice',
              voice: { mediaId: meta.media_id, mime: meta.mime_type, duration, waveform },
              ...(reply ? { replyTo: reply } : {}),
            })
          } catch (error) {
            setIssue(explain(error))
          } finally {
            setUploadProgress(null)
            setBusy(false)
          }
        })()
      }

      recorder.start(250)
      setRecSec(0)
      setRecording(true)
    } catch {
      teardownRecorder()
      setIssue('无法访问麦克风，请检查浏览器权限设置。')
    }
  }

  function cancelRecording() {
    cancelledRecRef.current = true
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    } else {
      teardownRecorder()
      setRecording(false)
    }
  }

  function finishRecording() {
    cancelledRecRef.current = false
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
  }

  function insert(text: string, wrap?: string) {
    const element = area.current
    if (!element) {
      setValue((current) => current + (wrap ? `${wrap}${text}${wrap}` : text))
      return
    }
    const start = element.selectionStart ?? value.length
    const end = element.selectionEnd ?? value.length
    const selected = value.slice(start, end)
    const inserted = wrap ? `${wrap}${selected || text}${wrap}` : text
    setValue(value.slice(0, start) + inserted + value.slice(end))
    requestAnimationFrame(() => {
      element.focus()
      const caret = start + inserted.length
      element.setSelectionRange(caret, caret)
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && replyTo) {
      setReplyTo(null)
      return
    }
    if (event.key === '@' && members.length > 0) {
      setMentionOpen(true)
    }
    const isSendTrigger = enterToSend
      ? (event.key === 'Enter' && !event.shiftKey)
      : (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
    if (isSendTrigger && !composing.current && event.keyCode !== 229) {
      event.preventDefault()
      void submit()
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files)
    if (files.length > 0) {
      event.preventDefault()
      stageFiles(files)
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (event.dataTransfer.files.length > 0) {
      stageFiles(event.dataTransfer.files)
    }
  }

  async function sendCodeSnippet() {
    if (!codeBody.trim() || busy) return
    setBusy(true)
    setIssue('')
    try {
      const reply = currentReplyRef()
      await sendRich({
        v: 1,
        lim_msg: true,
        kind: 'code',
        code: { lang: codeLang.trim() || 'text', content: codeBody },
        ...(codeNote.trim() ? { text: codeNote.trim() } : {}),
        ...(reply ? { replyTo: reply } : {}),
      })
      setCodeBody('')
      setCodeNote('')
      setModal('none')
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setBusy(false)
    }
  }

  function locateMe() {
    if (!navigator.geolocation) {
      setIssue('当前浏览器不支持定位，请手动填写地点名称。')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        if (!locName.trim()) setLocName('我的当前位置')
        if (!locAddr.trim()) setLocAddr(`纬度 ${pos.coords.latitude.toFixed(4)} · 经度 ${pos.coords.longitude.toFixed(4)}`)
        setLocating(false)
      },
      () => {
        setLocating(false)
        setIssue('获取定位失败，你可以直接手动填写地点。')
      },
      { timeout: 8000 },
    )
  }

  async function sendLocationCard() {
    if (!locName.trim() || busy) return
    setBusy(true)
    setIssue('')
    try {
      const reply = currentReplyRef()
      await sendRich({
        v: 1,
        lim_msg: true,
        kind: 'location',
        location: {
          name: locName.trim(),
          address: locAddr.trim() || '自定义分享位置',
          ...(locCoords ? { lat: locCoords.lat, lng: locCoords.lng } : {}),
        },
        ...(reply ? { replyTo: reply } : {}),
      })
      setLocName('')
      setLocAddr('')
      setLocCoords(null)
      setModal('none')
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setBusy(false)
    }
  }

  async function sendPollCard() {
    const cleanOptions = pollOptions.map((item) => item.trim()).filter(Boolean)
    if (!pollQuestion.trim() || cleanOptions.length < 2 || busy) return
    setBusy(true)
    setIssue('')
    try {
      const reply = currentReplyRef()
      await sendRich({
        v: 1,
        lim_msg: true,
        kind: 'poll',
        poll: { question: pollQuestion.trim(), options: cleanOptions },
        ...(reply ? { replyTo: reply } : {}),
      })
      setPollQuestion('')
      setPollOptions(['', ''])
      setModal('none')
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setBusy(false)
    }
  }

  if (active?.kind === 'system') {
    return (
      <div className={styles.wrap}>
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-xs font-bold text-muted-foreground">
          <Bell size={15} className="text-coral" aria-hidden="true" />
          系统消息频道为只读通知，服务端会在账号登录、设备变更时自动推送提醒。
        </div>
      </div>
    )
  }

  return (
    <div
      className={styles.wrap}
      onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input ref={imageInput} type="file" accept="image/*" multiple className="hidden"
        onChange={(event) => { if (event.target.files) stageFiles(event.target.files, 'image'); event.target.value = '' }} />
      <input ref={videoInput} type="file" accept="video/*" className="hidden"
        onChange={(event) => { if (event.target.files) stageFiles(event.target.files, 'video'); event.target.value = '' }} />
      <input ref={fileInput} type="file" className="hidden"
        onChange={(event) => { if (event.target.files) stageFiles(event.target.files, 'file'); event.target.value = '' }} />

      <div className={styles.box} style={dragging ? { borderColor: 'var(--tide)', boxShadow: '0 0 0 2px color-mix(in oklab, var(--tide) 25%, transparent)' } : undefined}>
        {/* 回复上下文 */}
        {replyTo && (
          <div className={styles.contextBar}>
            <span className={styles.contextLine} style={{ ['--c' as string]: roomColor(replyTo.senderId) }} />
            <span className="text-muted-foreground"><CornerUpLeft size={14} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-extrabold" style={{ color: roomColor(replyTo.senderId) }}>
                回复 {replyTo.senderName}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {summarizeProjected(replyTo)}
              </div>
            </div>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
              onClick={() => setReplyTo(null)}
              aria-label="取消回复"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* 待发媒体预览 */}
        {attachment && (
          <div className="flex items-center gap-2.5 px-3.5 pt-3">
            {attachment.kind === 'images' ? (
              <div className="flex flex-wrap gap-2">
                {attachment.files.map((entry, idx) => (
                  <div key={entry.previewUrl} className="relative size-16 overflow-hidden rounded-xl border border-border">
                    <img src={entry.previewUrl} alt={entry.file.name} className="size-full object-cover" />
                    <button
                      type="button"
                      className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-black/65 text-white"
                      onClick={() => {
                        const rest = attachment.files.filter((_, i) => i !== idx)
                        URL.revokeObjectURL(entry.previewUrl)
                        setAttachment(rest.length > 0 ? { kind: 'images', files: rest } : null)
                      }}
                      aria-label="移除图片"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : attachment.kind === 'video' ? (
              <div className="flex flex-1 items-center gap-2.5 rounded-xl bg-muted px-3 py-2">
                <Film size={18} className="shrink-0 text-tide" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold">{attachment.file.name}</div>
                  <div className="text-[11px] text-muted-foreground">视频 · {formatBytes(attachment.file.size)}</div>
                </div>
                <button type="button" onClick={() => replaceAttachment(null)} aria-label="移除视频"
                  className="grid size-6 place-items-center rounded-md hover:bg-accent">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="flex flex-1 items-center gap-2.5 rounded-xl bg-muted px-3 py-2">
                <FileText size={18} className="shrink-0 text-tide" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold">{attachment.file.name}</div>
                  <div className="text-[11px] text-muted-foreground">文件 · {formatBytes(attachment.file.size)}</div>
                </div>
                <button type="button" onClick={() => replaceAttachment(null)} aria-label="移除文件"
                  className="grid size-6 place-items-center rounded-md hover:bg-accent">
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* 上传进度 */}
        {uploadProgress !== null && (
          <div className="px-4 pt-2">
            <div className="flex items-center justify-between text-[11px] font-bold text-tide">
              <span className="inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> 正在上传媒体…</span>
              <span>{uploadProgress}%</span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-tide transition-all duration-150" style={{ width: `${uploadProgress}%` }} />
            </div>
          </div>
        )}

        {recording ? (
          <div className={styles.recording}>
            <span className={styles.recDot} />
            <span className="w-12 text-sm font-extrabold tabular-nums">
              {formatDuration(recSec)}
            </span>
            <div className={styles.recWave} aria-hidden="true">
              {liveBars.map((level, index) => (
                <i key={index} style={{ height: `${Math.round(level * 100)}%`, animation: 'none' }} />
              ))}
            </div>
            <button
              type="button"
              className="grid size-9 place-items-center rounded-xl text-muted-foreground hover:bg-muted"
              onClick={cancelRecording}
              aria-label="取消录音"
            >
              <Trash2 size={16} />
            </button>
            <button
              type="button"
              className={styles.send}
              style={{ marginLeft: 0 }}
              onClick={finishRecording}
            >
              <SendHorizontal size={15} /> 发送语音
            </button>
          </div>
        ) : (
          <>
            <textarea
              ref={area}
              className={styles.textarea}
              rows={1}
              value={value}
              aria-label="消息正文"
              aria-invalid={oversized || Boolean(issue)}
              placeholder={active
                ? attachment ? '添加图片/媒体说明（可选）…'
                  : active.kind === 'self' ? '记点什么，或拖拽照片、视频、文件到这里…'
                    : `发消息到 ${roomTitle(active, identity.account)}…`
                : '选择一个会话开始对话'}
              disabled={!timelineReady || !active || busy}
              onChange={(event) => { setValue(event.target.value); setIssue('') }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }}
            />
            <div className={styles.toolbar}>
              {/* 5 分类表情 */}
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
                <PopoverContent side="top" align="start" className="w-80 p-2">
                  <div className="mb-2 grid grid-cols-5 gap-1 rounded-lg bg-muted p-1">
                    {EMOJI_TABS.map((tabName) => (
                      <button
                        key={tabName}
                        type="button"
                        onClick={() => setEmojiTab(tabName)}
                        className={`rounded-md py-1 text-[11px] font-bold ${emojiTab === tabName ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground'}`}
                      >
                        {tabName}
                      </button>
                    ))}
                  </div>
                  <div className="grid max-h-44 grid-cols-8 gap-0.5 overflow-y-auto">
                    {(EMOJI_SET[emojiTab] ?? []).map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className="grid size-8 place-items-center rounded-lg text-lg transition-transform hover:scale-110 hover:bg-accent"
                        onClick={() => insert(emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* 附件菜单 */}
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button className={styles.tool} aria-label="发送附件" type="button" disabled={busy}>
                        <Paperclip size={18} />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>照片 / 视频 / 文件 / 投票</TooltipContent>
                </Tooltip>
                <DropdownMenuContent side="top" align="start" className="w-44">
                  <DropdownMenuLabel>媒体与文件</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => imageInput.current?.click()}>
                    <ImageIcon /> 照片（最多 4 张）
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => videoInput.current?.click()}>
                    <Film /> 视频
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                    <FileUp /> 文件
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>富交互卡片</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => setModal('code')}>
                    <Code /> 代码片段
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setModal('location')}>
                    <MapPin /> 分享位置
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setModal('poll')}>
                    <BarChart3 /> 发起投票
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* 快捷选图 */}
              <ToolButton label="分享照片" onClick={() => imageInput.current?.click()} disabled={busy}>
                <ImageIcon size={18} />
              </ToolButton>

              {/* 提及成员 */}
              {members.length > 0 && (
                <Popover open={mentionOpen} onOpenChange={setMentionOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <button className={styles.tool} aria-label="提及成员" type="button">
                          <AtSign size={18} />
                        </button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>提及成员</TooltipContent>
                  </Tooltip>
                  <PopoverContent side="top" align="start" className="w-60 p-1.5">
                    <div className="px-2 py-1 text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">提及成员</div>
                    {members.map((member) => (
                      <button
                        key={member.account}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                        onClick={() => {
                          const handle = member.display_name || member.username
                          const trimmed = value.endsWith('@') ? value.slice(0, -1) : value
                          setValue(`${trimmed}@${handle} `)
                          setMentionOpen(false)
                          area.current?.focus()
                        }}
                      >
                        <span
                          className="grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-extrabold text-white"
                          style={{ background: roomColor(member.account) }}
                        >
                          {avatarInitials(member.display_name || member.username)}
                        </span>
                        <span className="truncate text-xs font-bold">{member.display_name}</span>
                        <span className="ml-auto text-[11px] text-muted-foreground">@{member.username}</span>
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              )}

              <span className="mx-1 hidden h-5 w-px bg-border sm:inline-block" />
              <div className="hidden items-center gap-0.5 sm:flex">
                <ToolButton label="加粗" onClick={() => insert('文本', '**')}><Bold size={16} /></ToolButton>
                <ToolButton label="斜体" onClick={() => insert('文本', '_')}><Italic size={16} /></ToolButton>
                <ToolButton label="行内代码" onClick={() => insert('code', '`')}><Code size={16} /></ToolButton>
              </div>

              {hasContent || busy ? (
                <button className={styles.send} onClick={() => void submit()} disabled={!canSend} type="button">
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <SendHorizontal size={15} />}
                  {busy ? '发送中' : status.state === 'offline' ? '排队' : '发送'}
                </button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`${styles.tool} ml-auto`}
                      style={{ color: 'var(--coral)' }}
                      onClick={() => void startRecording()}
                      disabled={!timelineReady || !active}
                      aria-label="录制语音消息"
                      type="button"
                    >
                      <Mic size={18} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>发送语音消息</TooltipContent>
                </Tooltip>
              )}
            </div>
          </>
        )}
      </div>

      <div className={styles.hint}>
        <span data-error={oversized || Boolean(issue)}>
          {issue || (oversized ? '正文超过 64 KiB，无法发送。' : status.state === 'offline' ? '离线消息会排队，联网后自动发送。' : (
            <>
              {enterToSend ? <><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</>
                : <><kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> 发送 · <kbd>Enter</kbd> 换行</>}
              {' · '}支持拖拽或粘贴照片/视频/文件
            </>
          ))}
        </span>
        <span>{value.length > 0 && `${value.length} 字`}</span>
      </div>

      {/* 代码片段弹窗 */}
      {modal === 'code' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setModal('none') }}>
          <section className="w-full max-w-lg rounded-3xl border border-border bg-card p-5 shadow-2xl">
            <header className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-extrabold">发送代码片段</h3>
              <Button variant="ghost" size="icon-sm" onClick={() => setModal('none')} aria-label="关闭"><X /></Button>
            </header>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-bold">语言</label>
                  <Input value={codeLang} onChange={(e) => setCodeLang(e.target.value)} placeholder="tsx / cpp / sql" className="mt-1" />
                </div>
                <div>
                  <label className="text-xs font-bold">说明（可选）</label>
                  <Input value={codeNote} onChange={(e) => setCodeNote(e.target.value)} placeholder="给这段代码加一句备注" className="mt-1" />
                </div>
              </div>
              <div>
                <label className="text-xs font-bold">代码内容</label>
                <textarea
                  rows={8}
                  value={codeBody}
                  onChange={(e) => setCodeBody(e.target.value)}
                  placeholder="粘贴或输入代码…"
                  className="mt-1 w-full rounded-xl border border-border bg-muted p-3 font-mono text-xs outline-none focus:border-tide"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setModal('none')}>取消</Button>
                <Button disabled={!codeBody.trim() || busy} onClick={() => void sendCodeSnippet()}>
                  <SendHorizontal size={14} /> 发送代码
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* 分享位置弹窗 */}
      {modal === 'location' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setModal('none') }}>
          <section className="w-full max-w-md rounded-3xl border border-border bg-card p-5 shadow-2xl">
            <header className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-extrabold">分享位置</h3>
              <Button variant="ghost" size="icon-sm" onClick={() => setModal('none')} aria-label="关闭"><X /></Button>
            </header>
            <div className="space-y-3">
              <Button type="button" variant="secondary" className="w-full justify-center" disabled={locating} onClick={locateMe}>
                {locating ? <Loader2 size={14} className="animate-spin" /> : <LocateFixed size={14} />}
                {locating ? '正在获取定位…' : '使用浏览器当前位置'}
              </Button>
              <div>
                <label className="text-xs font-bold">地点名称</label>
                <Input value={locName} onChange={(e) => setLocName(e.target.value)} placeholder="例如：厦门 · 白城沙滩" className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-bold">详细地址</label>
                <Input value={locAddr} onChange={(e) => setLocAddr(e.target.value)} placeholder="街道或补充说明" className="mt-1" />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setModal('none')}>取消</Button>
                <Button disabled={!locName.trim() || busy} onClick={() => void sendLocationCard()}>
                  <MapPin size={14} /> 发送位置
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* 发起投票弹窗 */}
      {modal === 'poll' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setModal('none') }}>
          <section className="w-full max-w-md rounded-3xl border border-border bg-card p-5 shadow-2xl">
            <header className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-extrabold">发起投票</h3>
              <Button variant="ghost" size="icon-sm" onClick={() => setModal('none')} aria-label="关闭"><X /></Button>
            </header>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold">投票主题</label>
                <Input value={pollQuestion} onChange={(e) => setPollQuestion(e.target.value)} placeholder="例如：周五聚餐吃什么？" className="mt-1" />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold">选项（至少 2 项）</label>
                {pollOptions.map((opt, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <Input
                      value={opt}
                      onChange={(e) => setPollOptions((list) => list.map((item, i) => (i === idx ? e.target.value : item)))}
                      placeholder={`选项 ${idx + 1}`}
                    />
                    {pollOptions.length > 2 && (
                      <Button variant="ghost" size="icon-sm" onClick={() => setPollOptions((list) => list.filter((_, i) => i !== idx))} aria-label="删除选项">
                        <X size={14} />
                      </Button>
                    )}
                  </div>
                ))}
                {pollOptions.length < 6 && (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setPollOptions((list) => [...list, ''])}>
                    <Plus size={14} /> 添加选项
                  </Button>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setModal('none')}>取消</Button>
                <Button
                  disabled={!pollQuestion.trim() || pollOptions.filter((o) => o.trim()).length < 2 || busy}
                  onClick={() => void sendPollCard()}
                >
                  <BarChart3 size={14} /> 发布投票
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
