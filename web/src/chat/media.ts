import { useEffect, useState } from 'react'
import { useChat } from './chat-context'

const urlCache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

function cacheKey(generation: string, roomId: string, mediaId: string) {
  return `${generation}/${roomId}/${mediaId}`
}

export function clearMediaObjectUrls() {
  for (const url of urlCache.values()) {
    URL.revokeObjectURL(url)
  }
  urlCache.clear()
  inflight.clear()
}

export function useMediaUrl(roomId: string | undefined, mediaId: string | undefined) {
  const { client, identity } = useChat()
  const key = roomId && mediaId ? cacheKey(identity.generation, roomId, mediaId) : ''
  const cached = key ? urlCache.get(key) ?? '' : ''
  const [loaded, setLoaded] = useState<{ key: string; url: string; error: boolean }>({
    key: '',
    url: '',
    error: false,
  })

  useEffect(() => {
    if (!roomId || !mediaId || !key || urlCache.has(key)) return
    let cancelled = false
    let promise = inflight.get(key)
    if (!promise) {
      const controller = new AbortController()
      promise = client.fetchMedia(identity.generation, roomId, mediaId, controller.signal)
        .then((blob) => {
          const objectUrl = URL.createObjectURL(blob)
          urlCache.set(key, objectUrl)
          return objectUrl
        })
        .finally(() => {
          inflight.delete(key)
        })
      inflight.set(key, promise)
    }
    void promise
      .then((objectUrl) => {
        if (!cancelled) setLoaded({ key, url: objectUrl, error: false })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, url: '', error: true })
      })
    return () => {
      cancelled = true
    }
  }, [client, identity.generation, roomId, mediaId, key])

  const url = cached || (loaded.key === key ? loaded.url : '')
  const error = !cached && loaded.key === key && loaded.error
  return { url, loading: Boolean(key && !url && !error), error }
}

export async function downloadMedia(
  fetcher: () => Promise<Blob>,
  filename: string,
) {
  const blob = await fetcher()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename || 'attachment'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
