import { ArrowRight, Cable, Eye, EyeOff, Loader2, Radio, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { ChatHeader } from './components/ChatHeader'
import { Composer } from './components/Composer'
import { InfoPanel } from './components/InfoPanel'
import { MessageList } from './components/MessageList'
import { Rail } from './components/Rail'
import { Sidebar } from './components/Sidebar'
import { WaveLine, WaveMark, WaveStack } from './components/WaveDecor'
import { ChatProvider } from './chat/store'
import { useChat } from './chat/chat-context'
import { LimClient, explain } from './chat/protocol'
import type { Identity } from './chat/protocol'
import styles from './App.module.css'

interface Session {
  client: LimClient
  identity: Identity
}

/* ───────────────── 入口 ───────────────── */

function Connect({ issue, enter }: { issue: string; enter: (session: Session) => void }) {
  const [token, setToken] = useState('')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = token.trim()
    if (!/^[0-9a-f]{64}$/.test(value)) {
      setError('请输入 64 位小写十六进制设备令牌。')
      return
    }
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      const client = new LimClient(value)
      const identity = await client.identify(controller.signal)
      if (!controller.signal.aborted) enter({ client, identity })
    } catch (error) {
      if (!controller.signal.aborted) setError(explain(error))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <main className={styles.entry}>
      <section className={styles.entryAside}>
        <span className={styles.brand}>
          <WaveMark size={40} />
          <span>
            <strong>LIM</strong>
            <small>潮汐同步的本地即时消息</small>
          </span>
        </span>

        <div className={styles.claim}>
          <WaveLine className="mb-6 w-24 text-tide" />
          <h1>连接设备，<br />继续对话。</h1>
          <p>消息落在服务端，刷新、断线、换标签页都不会散落。设备令牌只保存在内存里。</p>
        </div>

        <div className={styles.caption}>
          <Cable size={16} aria-hidden="true" /> 连接当前 LIM 服务
        </div>
        <WaveStack className={styles.waves} />
      </section>

      <section className={styles.entryContent} aria-labelledby="connect-title">
        <form className={styles.login} onSubmit={submit} noValidate>
          <div className={styles.loginIcon}><Radio size={24} aria-hidden="true" /></div>
          <h2 id="connect-title">连接设备</h2>
          <p>使用服务端配置的设备令牌进入已分配的会话。</p>

          <label htmlFor="token">设备令牌</label>
          <div className={styles.token}>
            <Input id="token" autoComplete="off" autoCapitalize="off" spellCheck={false}
              placeholder="粘贴 64 位设备令牌" type={visible ? 'text' : 'password'} value={token}
              aria-invalid={Boolean(error)} aria-describedby={error || issue ? 'connect-error' : undefined}
              onChange={(event) => { setToken(event.target.value); setError('') }} />
            <Button type="button" variant="ghost" size="icon"
              aria-label={visible ? '隐藏令牌' : '显示令牌'} aria-pressed={visible}
              onClick={() => setVisible(!visible)}>
              {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </Button>
          </div>

          {(error || issue) && (
            <p role="alert" id="connect-error" className={styles.error}>
              <TriangleAlert size={14} aria-hidden="true" /> {error || issue}
            </p>
          )}

          <Button type="submit" size="lg" disabled={busy} className="mt-1 w-full justify-between">
            {busy ? <><Loader2 className="animate-spin" /> 正在连接…</> : <>进入会话 <ArrowRight /></>}
          </Button>

          <p className={styles.note}><Eye size={13} aria-hidden="true" /> 服务端可读此会话的消息内容</p>
        </form>
      </section>
    </main>
  )
}

/* ───────────────── 工作区 ───────────────── */

function EmptyRoom() {
  return (
    <div className={styles.empty}>
      <svg viewBox="0 0 160 80" className={styles.emptyWaves} aria-hidden="true">
        <path d="M0 40c13-14 27-14 40 0s27 14 40 0 27-14 40 0 27 14 40 0" fill="none" stroke="var(--tide)" strokeWidth="3" strokeLinecap="round" />
        <path d="M0 58c13-14 27-14 40 0s27 14 40 0 27-14 40 0 27 14 40 0" fill="none" stroke="var(--coral)" strokeWidth="3" strokeLinecap="round" opacity=".75" />
      </svg>
      <h2>选择一段对话</h2>
      <p>左侧列出了这台设备可以访问的全部会话。潮水会自己把新消息推过来。</p>
    </div>
  )
}

function Shell({ onDisconnect }: { onDisconnect: () => void }) {
  const { active, status, issue, infoOpen, retry } = useChat()

  return (
    <div className={styles.app} data-room-open={Boolean(active)}>
      <Rail onDisconnect={onDisconnect} />
      <div className={styles.sidebarSlot}>
        <Sidebar />
      </div>

      <main className={styles.main}>
        {status.state === 'offline' && (
          <div className={styles.banner}>
            <i aria-hidden="true" /> 潮汐暂时退去 · 正在重新连接…
          </div>
        )}

        {active ? (
          <>
            <ChatHeader />
            {issue && (
              <div className={styles.notice} role="status">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>{issue}</span>
                <Button size="sm" variant="secondary" onClick={retry}>重试同步</Button>
              </div>
            )}
            <MessageList />
            <Composer key={active.conversation_id} />
          </>
        ) : (
          <EmptyRoom />
        )}
      </main>

      {active && infoOpen && <InfoPanel onDisconnect={onDisconnect} />}
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [issue, setIssue] = useState('')
  const [disconnect] = useState(() => (reason = '') => {
    setIssue(reason)
    setSession(null)
  })

  if (!session) {
    return <Connect issue={issue} enter={(value) => { setIssue(''); setSession(value) }} />
  }

  return (
    <ChatProvider client={session.client} identity={session.identity} disconnect={disconnect}>
      <Shell onDisconnect={() => disconnect()} />
    </ChatProvider>
  )
}
