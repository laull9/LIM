import { ArrowRight, Cable, Eye, EyeOff, Loader2, LogIn, Monitor, Radio, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
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
import {
  clearSavedAuth, identityFromAuth, loadSavedAuth, rotateAuth, saveAuth,
  stableDeviceId, browserDeviceName,
} from './chat/auth'
import { LimClient, explain, login as loginAccount, register as registerAccount, sessionEnded } from './chat/protocol'
import type { Account, AuthResult, Device, Identity } from './chat/protocol'
import { clearCachedChats } from './chat/storage'
import styles from './App.module.css'

interface Session {
  client: LimClient
  identity: Identity
  auth: AuthResult | null
  kind: 'account' | 'device'
}

type EntryMode = 'login' | 'register' | 'device'

/* ───────────────── 入口 ───────────────── */

function Connect({ issue, enterAccount, enterDevice }: {
  issue: string
  enterAccount: (auth: AuthResult) => void
  enterDevice: (token: string, identity: Identity) => void
}) {
  const [mode, setMode] = useState<EntryMode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [token, setToken] = useState('')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      if (mode === 'device') {
        const value = token.trim()
        if (!/^[0-9a-f]{64}$/.test(value)) {
          setError('请输入 64 位小写十六进制设备令牌。')
          return
        }
        const client = new LimClient(value)
        const identity = await client.identify(controller.signal)
        if (!controller.signal.aborted) enterDevice(value, identity)
        return
      }
      const common = {
        username: username.trim(),
        password,
        device_id: stableDeviceId(),
        device_name: browserDeviceName(),
      }
      const auth = mode === 'register'
        ? await registerAccount({
          ...common,
          display_name: displayName.trim() || common.username,
        }, controller.signal)
        : await loginAccount(common, controller.signal)
      if (!controller.signal.aborted) enterAccount(auth)
    } catch (caught) {
      if (!controller.signal.aborted) setError(explain(caught))
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
          <h1>用人名，<br />而不是设备号。</h1>
          <p>注册一次账号，浏览器会自动登记为你的设备。消息保存在服务端，刷新、断线和换设备都能继续。</p>
        </div>

        <div className={styles.caption}>
          <Cable size={16} aria-hidden="true" /> 连接当前 LIM 服务
        </div>
        <WaveStack className={styles.waves} />
      </section>

      <section className={styles.entryContent} aria-labelledby="connect-title">
        <form className={styles.login} onSubmit={submit} noValidate>
          <div className={styles.loginIcon}>
            {mode === 'device' ? <Radio size={24} aria-hidden="true" /> : <LogIn size={24} aria-hidden="true" />}
          </div>
          <h2 id="connect-title">{mode === 'device' ? '连接受控设备' : mode === 'register' ? '创建账号' : '登录账号'}</h2>
          <p>
            {mode === 'device'
              ? '开发或受控集成可继续使用服务端预配置的设备令牌。'
              : '账号用于找人和聊天；当前浏览器会自动登记为一台设备。'}
          </p>

          <div className="mt-1 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="登录方式">
            {([['login', '登录'], ['register', '注册'], ['device', '设备令牌']] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                className={`rounded-lg px-2 py-1.5 text-xs font-bold transition-colors ${mode === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => { setMode(key); setError('') }}
              >
                {label}
              </button>
            ))}
          </div>

          {mode !== 'device' ? (
            <>
              <label htmlFor="username">用户名</label>
              <Input id="username" autoComplete="username" autoCapitalize="off" spellCheck={false}
                placeholder="3–24 位字母、数字或下划线" value={username}
                onChange={(event) => { setUsername(event.target.value); setError('') }} />
              {mode === 'register' && (
                <>
                  <label htmlFor="display-name">昵称</label>
                  <Input id="display-name" autoComplete="nickname" placeholder="别人看到的名字"
                    value={displayName} onChange={(event) => { setDisplayName(event.target.value); setError('') }} />
                </>
              )}
              <label htmlFor="password">密码</label>
              <div className={styles.token}>
                <Input id="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  placeholder="至少 8 位" type={visible ? 'text' : 'password'} value={password}
                  aria-invalid={Boolean(error)}
                  onChange={(event) => { setPassword(event.target.value); setError('') }} />
                <Button type="button" variant="ghost" size="icon"
                  aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible}
                  onClick={() => setVisible(!visible)}>
                  {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </Button>
              </div>
            </>
          ) : (
            <>
              <label htmlFor="token">设备令牌</label>
              <div className={styles.token}>
                <Input id="token" autoComplete="off" autoCapitalize="off" spellCheck={false}
                  placeholder="粘贴 64 位设备令牌" type={visible ? 'text' : 'password'} value={token}
                  aria-invalid={Boolean(error)} onChange={(event) => { setToken(event.target.value); setError('') }} />
                <Button type="button" variant="ghost" size="icon"
                  aria-label={visible ? '隐藏令牌' : '显示令牌'} aria-pressed={visible}
                  onClick={() => setVisible(!visible)}>
                  {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </Button>
              </div>
            </>
          )}

          {(error || issue) && (
            <p role="alert" id="connect-error" className={styles.error}>
              <TriangleAlert size={14} aria-hidden="true" /> {error || issue}
            </p>
          )}

          <Button type="submit" size="lg" disabled={busy} className="mt-1 w-full justify-between">
            {busy ? <><Loader2 className="animate-spin" /> 正在连接…</> : <>{mode === 'register' ? '创建并进入' : '进入会话'} <ArrowRight /></>}
          </Button>

          <p className={styles.note}><Eye size={13} aria-hidden="true" /> 当前会话为宿主可读；端到端加密尚未启用</p>
        </form>
      </section>
    </main>
  )
}

/* ───────────────── 账号工作区弹层 ───────────────── */

function Panel({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section role="dialog" aria-modal="true" aria-label={title}
        className="max-h-[min(80dvh,680px)] w-full max-w-lg overflow-y-auto rounded-3xl border border-border bg-card p-5 text-foreground shadow-2xl">
        <header className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-extrabold tracking-tight">{title}</h2>
          <Button variant="ghost" size="icon" onClick={close} aria-label="关闭"><X /></Button>
        </header>
        {children}
      </section>
    </div>
  )
}

function NewChatPanel({ close }: { close: () => void }) {
  const { client, identity, refresh, openRoom } = useChat()
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<Account[]>([])
  const [selected, setSelected] = useState<Account[]>([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState('')

  const visibleUsers = query.trim() ? users : []

  useEffect(() => {
    if (query.trim().length < 1) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void client.searchAccounts(identity.generation, query.trim(), controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setUsers(result.users.filter((user) => user.account !== identity.account))
            setIssue('')
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setIssue(explain(error))
        })
    }, 220)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [client, identity.account, identity.generation, query])

  function toggle(user: Account) {
    setSelected((current) => current.some((entry) => entry.account === user.account)
      ? current.filter((entry) => entry.account !== user.account)
      : [...current, user])
  }

  async function create() {
    if (selected.length === 0 || busy) return
    if (selected.length > 1 && !title.trim()) {
      setIssue('请给小群起一个名字。')
      return
    }
    setBusy(true)
    setIssue('')
    try {
      const room = await client.startConversation(identity.generation,
        selected.map((user) => user.account), selected.length > 1 ? title.trim() : undefined,
        new AbortController().signal)
      refresh()
      openRoom(room.conversation_id)
      close()
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="发起聊天" close={close}>
      <label htmlFor="people-search" className="text-xs font-bold">按用户名找人</label>
      <Input id="people-search" value={query} autoFocus placeholder="输入用户名开头"
        onChange={(event) => setQuery(event.target.value)} className="mt-1.5" />
      <div className="mt-3 max-h-56 overflow-y-auto rounded-xl border border-border">
        {visibleUsers.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {query.trim() ? '没有匹配的用户。' : '输入用户名以搜索账号。'}
          </p>
        ) : visibleUsers.map((user) => (
          <button key={user.account} type="button" onClick={() => toggle(user)}
            className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-accent">
            <span className="min-w-0">
              <strong className="block truncate text-sm">{user.display_name}</strong>
              <small className="block truncate text-xs text-muted-foreground">@{user.username}</small>
            </span>
            <span className={`grid size-5 place-items-center rounded-full border ${selected.some((entry) => entry.account === user.account) ? 'border-tide bg-tide text-white' : 'border-border'}`}>
              {selected.some((entry) => entry.account === user.account) ? '✓' : ''}
            </span>
          </button>
        ))}
      </div>
      {selected.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {selected.map((user) => (
            <button key={user.account} type="button" onClick={() => toggle(user)}
              className="rounded-full bg-accent px-2.5 py-1 text-xs font-bold">
              {user.display_name} ×
            </button>
          ))}
        </div>
      )}
      {selected.length > 1 && (
        <>
          <label htmlFor="group-title" className="mt-4 block text-xs font-bold">群名称</label>
          <Input id="group-title" value={title} placeholder="给这段对话一个名字"
            onChange={(event) => setTitle(event.target.value)} className="mt-1.5" />
        </>
      )}
      {issue && <p role="alert" className="mt-3 text-xs font-bold text-destructive">{issue}</p>}
      <Button type="button" className="mt-4 w-full justify-between" disabled={busy || selected.length === 0}
        onClick={() => void create()}>
        {busy ? <><Loader2 className="animate-spin" /> 正在创建…</> : <>{selected.length > 1 ? '创建小群' : '开始私聊'} <ArrowRight /></>}
      </Button>
    </Panel>
  )
}

function DevicesPanel({ close }: { close: () => void }) {
  const { client, identity, logout } = useChat()
  const [devices, setDevices] = useState<Device[]>([])
  const [busy, setBusy] = useState('')
  const [issue, setIssue] = useState('')

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await client.listDevices(identity.generation, signal)
      setDevices(result.devices)
      setIssue('')
    } catch (error) {
      if (!signal.aborted) setIssue(explain(error))
    }
  }, [client, identity.generation])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => void load(controller.signal), 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [load])

  async function remove(device: Device) {
    setBusy(device.device_id)
    setIssue('')
    try {
      await client.removeDevice(identity.generation, device.device_id, new AbortController().signal)
      if (device.device_id === identity.device) {
        await logout()
        close()
      } else {
        await load(new AbortController().signal)
      }
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setBusy('')
    }
  }

  async function logoutAndClear() {
    setBusy('clear')
    try {
      await clearCachedChats()
      await logout()
      close()
    } catch (error) {
      setIssue(explain(error))
    } finally {
      setBusy('')
    }
  }

  return (
    <Panel title="账号与设备" close={close}>
      <div className="rounded-2xl bg-muted p-3 text-sm">
        <strong className="block font-extrabold">{identity.display_name || (identity.username ? `@${identity.username}` : '受控设备')}</strong>
        <span className="mt-0.5 block break-all font-mono text-[10px] text-muted-foreground">{identity.account}</span>
      </div>
      <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-border">
        {devices.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">暂无设备记录。</p>
        ) : devices.map((device) => (
          <div key={device.device_id} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
            <Monitor size={18} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-sm">{device.name}</strong>
              <small className="block truncate font-mono text-[10px] text-muted-foreground">{device.device_id}</small>
            </div>
            {device.device_id === identity.device && <span className="rounded-full bg-tide/15 px-2 py-0.5 text-[10px] font-bold text-tide">当前</span>}
            {device.revoked
              ? <span className="text-[10px] font-bold text-destructive">已撤销</span>
              : <Button size="sm" variant="ghost" disabled={busy === device.device_id}
                onClick={() => void remove(device)}>撤销</Button>}
          </div>
        ))}
      </div>
      {issue && <p role="alert" className="mt-3 text-xs font-bold text-destructive">{issue}</p>}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        撤销设备会结束该设备的登录，并阻止它继续读取会话。退出登录只结束当前访问会话；清除本机缓存会删除此浏览器保存的消息副本。
      </p>
      <div className="mt-4 flex flex-col gap-2">
        <Button variant="secondary" onClick={() => void logout()}><LogIn /> 退出当前登录</Button>
        <Button variant="ghost" className="justify-start text-destructive" disabled={busy === 'clear'}
          onClick={() => void logoutAndClear()}>退出并清除本机缓存</Button>
      </div>
    </Panel>
  )
}

function Workspace() {
  const { workspace, setWorkspace } = useChat()
  const close = () => setWorkspace('none')
  if (workspace === 'new') return <NewChatPanel close={close} />
  if (workspace === 'devices') return <DevicesPanel close={close} />
  return null
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
      <p>从左侧选一段已缓存的会话，或点右上角的人形按钮找人聊天。断网时仍可阅读本地历史。</p>
    </div>
  )
}

function Shell() {
  const { active, status, issue, infoOpen, retry, workspace } = useChat()

  return (
    <div className={styles.app} data-room-open={Boolean(active)}>
      <Rail />
      <div className={styles.sidebarSlot}>
        <Sidebar />
      </div>

      <main className={styles.main}>
        {status.state === 'offline' && (
          <div className={styles.banner}>
            <i aria-hidden="true" /> 潮汐暂时退去 · 缓存仍可阅读，消息会排队等待发送
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

      {active && infoOpen && <InfoPanel />}
      {workspace !== 'none' && <Workspace />}
    </div>
  )
}

function Booting() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-3 text-sm font-bold text-muted-foreground">
        <WaveMark size={42} />
        <span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> 正在恢复登录…</span>
      </div>
    </main>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [issue, setIssue] = useState('')
  const [booting, setBooting] = useState(() => loadSavedAuth() !== null)

  const endSession = useCallback((reason = '', clear = true) => {
    if (clear) clearSavedAuth()
    setIssue(reason)
    setSession(null)
  }, [])

  const makeSession = useCallback((auth: AuthResult): Session => {
    const refreshAccess = async (signal: AbortSignal) => {
      try {
        const next = await rotateAuth(auth, signal)
        setSession((current) => {
          if (!current || current.kind !== 'account' || current.auth?.account !== next.account ||
              current.auth?.device !== next.device) {
            return current
          }
          current.client.setAccessToken(next.access_token)
          return { ...current, auth: next, identity: identityFromAuth(next) }
        })
        return next.access_token
      } catch (error) {
        if (sessionEnded(error)) endSession(explain(error))
        throw error
      }
    }
    return {
      client: new LimClient(auth.access_token, refreshAccess),
      identity: identityFromAuth(auth),
      auth,
      kind: 'account',
    }
  }, [endSession])

  const enterAccount = useCallback((auth: AuthResult) => {
    saveAuth(auth)
    setIssue('')
    setSession(makeSession(auth))
  }, [makeSession])

  const enterDevice = useCallback((token: string, identity: Identity) => {
    setIssue('')
    setSession({ client: new LimClient(token), identity, auth: null, kind: 'device' })
  }, [])

  useEffect(() => {
    const stored = loadSavedAuth()
    if (!stored) return
    const saved: AuthResult = stored
    const controller = new AbortController()
    async function restore() {
      let auth: AuthResult = saved
      if (navigator.onLine) {
        try {
          auth = await rotateAuth(saved, controller.signal)
        } catch (error) {
          if (sessionEnded(error)) {
            clearSavedAuth(saved)
            setIssue(explain(error))
            setBooting(false)
            return
          }
        }
      }
      if (!controller.signal.aborted) setSession(makeSession(auth))
      setBooting(false)
    }
    void restore()
    return () => controller.abort()
  }, [makeSession])

  const onLogout = useCallback(async () => {
    if (!session) return
    if (session.kind === 'account') {
      try {
        await session.client.logout(new AbortController().signal)
      } catch (error) {
        if (!sessionEnded(error)) setIssue(explain(error))
      }
    }
    endSession('', true)
  }, [session, endSession])

  const disconnect = useCallback((reason = '') => endSession(reason, true), [endSession])

  if (booting) return <Booting />
  if (!session) {
    return <Connect issue={issue} enterAccount={enterAccount} enterDevice={enterDevice} />
  }

  return (
    <ChatProvider client={session.client} identity={session.identity}
      disconnect={disconnect} onLogout={onLogout}>
      <Shell />
    </ChatProvider>
  )
}
