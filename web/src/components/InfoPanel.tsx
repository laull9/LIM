import {
  ArrowUp, Bell, Bookmark, Download, FileText, Film, LogOut, PenLine, Pin, RefreshCw,
  RotateCcw, UserPlus, Users, X,
} from 'lucide-react'
import { useState } from 'react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Separator } from './ui/separator'
import { WaveStack } from './WaveDecor'
import { useChat } from '../chat/chat-context'
import { downloadMedia, useMediaUrl } from '../chat/media'
import { avatarInitials, roomColor, roomSubtitle, roomTitle } from '../chat/naming'
import { formatBytes, summarizeProjected } from '../chat/rich-message'
import type { ProjectedMediaItem } from '../chat/rich-message'

const LABEL = { online: '已连接', offline: '离线缓存', loading: '同步中', blocked: '同步暂停' } as const

type TabKey = 'members' | 'media' | 'files' | 'pins'

function Row({ label, value, mono = true, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[11px] font-bold text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[11px] font-semibold ${mono ? 'font-mono' : ''}`}
        title={title ?? value}
      >
        {value}
      </span>
    </div>
  )
}

function MediaTile({ roomId, item, onOpen }: { roomId: string; item: ProjectedMediaItem; onOpen: () => void }) {
  const { url, loading } = useMediaUrl(roomId, item.media.mediaId)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-square overflow-hidden rounded-lg bg-muted text-left"
      title={item.media.name}
    >
      {item.kind === 'image' ? (
        url ? <img src={url} alt={item.media.name} className="size-full object-cover transition-transform group-hover:scale-105" />
          : <span className="grid size-full place-items-center text-[10px] font-bold text-muted-foreground">{loading ? '加载…' : '图片'}</span>
      ) : (
        <div className="relative grid size-full place-items-center bg-black/80 text-white">
          {url && <video src={url} muted className="size-full object-cover opacity-75" />}
          <span className="absolute inset-0 grid place-items-center">
            <Film size={20} />
          </span>
        </div>
      )}
    </button>
  )
}

/** 会话信息面板：成员、共享媒体与文件、置顶消息、真实同步元数据。 */
export function InfoPanel() {
  const {
    client, active, identity, status, position, projected, canLoadOlder, olderBusy,
    loadOlderMessages, retry, refresh, setInfoOpen, logout, setLightbox, togglePin,
    contacts, addContact, startDirectChat,
  } = useChat()
  const [tab, setTab] = useState<TabKey>('media')
  if (!active) return null
  const id = active.conversation_id
  const title = roomTitle(active, identity.account)
  const members = active.members ?? []
  const contactSet = new Set(contacts.map((c) => c.account))

  return (
    <aside className="flex w-[320px] shrink-0 animate-in flex-col border-l border-border bg-card fade-in-0 slide-in-from-right-4 duration-200">
      <div className="flex h-[68px] shrink-0 items-center justify-between border-b border-border px-4">
        <h3 className="text-sm font-extrabold">会话信息</h3>
        <Button variant="ghost" size="icon-sm" onClick={() => setInfoOpen(false)} aria-label="关闭信息面板">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative overflow-hidden">
          <WaveStack className="absolute bottom-0 left-0 h-16 w-full" />
          <div className="relative flex flex-col items-center px-5 pb-8 pt-6 text-center">
            <span
              className="grid size-[74px] place-items-center text-white"
              style={{ background: roomColor(id, active.kind), borderRadius: active.kind === 'direct' ? 999 : 24 }}
              aria-hidden="true"
            >
              {active.kind === 'system' ? <Bell size={30} />
                : active.kind === 'self' ? <Bookmark size={30} />
                  : active.kind === 'group' ? <Users size={30} />
                    : <span className="text-2xl font-extrabold">{avatarInitials(title)}</span>}
            </span>
            <div className="mt-3 text-base font-extrabold">{title}</div>
            <div className="mt-1 text-xs font-semibold text-muted-foreground">{roomSubtitle(active, identity.account)}</div>
            <Badge variant="muted" className="mt-2 gap-1">宿主可读 · {LABEL[status.state]}</Badge>
          </div>
        </div>

        <Separator />

        <div className="px-4 pt-3 pb-4">
          <div className="grid grid-cols-4 gap-1 rounded-xl bg-muted p-1" role="tablist">
            {([
              ['media', `媒体 ${projected.media.length || ''}`.trim()],
              ['files', `文件 ${projected.files.length || ''}`.trim()],
              ['pins', `置顶 ${projected.pinned.length || ''}`.trim()],
              ['members', `成员 ${members.length || ''}`.trim()],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`rounded-lg py-1 text-[11px] font-bold transition-colors ${tab === key ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'media' && (
            <div className="mt-3">
              {projected.media.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">暂无照片或视频</p>
              ) : (
                <div className="grid grid-cols-3 gap-1.5">
                  {projected.media.slice(0, 18).map((item) => (
                    <MediaTile
                      key={`${item.seq}-${item.media.mediaId}`}
                      roomId={id}
                      item={item}
                      onOpen={() => setLightbox({
                        roomId: id,
                        mediaId: item.media.mediaId,
                        kind: item.kind,
                        name: item.media.name,
                        mime: item.media.mime,
                      })}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'files' && (
            <div className="mt-3 space-y-1">
              {projected.files.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">暂无共享文件</p>
              ) : projected.files.map((item) => (
                <div key={`${item.seq}-${item.file.mediaId}`} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-muted">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-tide/15 text-tide">
                    <FileText size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-bold">{item.file.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatBytes(item.file.size)} · {item.senderName}
                    </div>
                  </div>
                  <Button size="icon-xs" variant="ghost" aria-label="下载文件"
                    onClick={() => void downloadMedia(
                      () => client.fetchMedia(identity.generation, id, item.file.mediaId, new AbortController().signal),
                      item.file.name,
                    )}>
                    <Download />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {tab === 'pins' && (
            <div className="mt-3 space-y-2">
              {projected.pinned.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">暂无置顶消息</p>
              ) : projected.pinned.map((msg) => (
                <div key={msg.id} className="rounded-xl border border-border p-2.5">
                  <div className="flex items-center gap-1 text-[11px] font-extrabold text-tide">
                    <Pin size={11} /> {msg.senderName} · #{msg.seq}
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs">{summarizeProjected(msg)}</div>
                  {msg.seq && active.kind !== 'system' && (
                    <button
                      type="button"
                      className="mt-1.5 text-[11px] font-bold text-muted-foreground hover:text-foreground"
                      onClick={() => void togglePin(msg.seq!, false)}
                    >
                      取消置顶
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'members' && (
            <div className="mt-3 space-y-1">
              {members.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">暂无成员信息</p>
              ) : members.map((member) => {
                const isMe = member.account === identity.account
                const isContact = contactSet.has(member.account)
                return (
                  <div key={member.account} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-muted">
                    <span
                      className="grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-extrabold text-white"
                      style={{ background: roomColor(member.account) }}
                    >
                      {avatarInitials(member.display_name || member.username)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-bold">
                        {member.display_name} {isMe && <span className="text-muted-foreground">(我)</span>}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">@{member.username}</div>
                    </div>
                    {!isMe && (
                      <div className="flex gap-1">
                        {!isContact && (
                          <Button size="icon-xs" variant="ghost" aria-label="加为联系人"
                            onClick={() => void addContact(member.account)}>
                            <UserPlus />
                          </Button>
                        )}
                        <Button size="icon-xs" variant="secondary" aria-label="发起私聊"
                          onClick={() => void startDirectChat(member.account)}>
                          <PenLine />
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <Separator />

        <div className="px-4 py-3">
          <div className="mb-1 text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">同步状态</div>
          <Row label="最新序号" value={`#${active.last_seq}`} />
          <Row label="已加载消息" value={`${projected.messages.length} 条`} mono={false} />
          <Row label="已补齐至" value={position ? `#${position.after}` : '—'} />
          <Row label="向上边界" value={position ? `#${position.before}` : '—'} />
        </div>

        <div className="space-y-1.5 px-3 pb-3">
          <Button variant="secondary" className="w-full justify-start" disabled={!canLoadOlder || olderBusy}
            onClick={loadOlderMessages}>
            <ArrowUp /> {olderBusy ? '正在打捞…' : canLoadOlder ? '加载更早消息' : '已到会话起点'}
          </Button>
          <Button variant="secondary" className="w-full justify-start" onClick={refresh}>
            <RefreshCw /> 刷新会话目录
          </Button>
          <Button variant="secondary" className="w-full justify-start" onClick={retry}>
            <RotateCcw /> 重新同步
          </Button>
        </div>

        <Separator />

        <div className="p-3">
          <Button variant="ghost" className="w-full justify-start text-coral hover:bg-coral/10 hover:text-coral"
            onClick={() => void logout()}>
            <LogOut /> 退出登录
          </Button>
        </div>
      </div>
    </aside>
  )
}
