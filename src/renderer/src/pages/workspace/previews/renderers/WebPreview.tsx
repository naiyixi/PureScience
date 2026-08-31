/* Hallmark · pre-emit critique: P5 H5 E4 S4 R4 V5 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Globe2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useLanguage } from '@/i18n'

// Progress advances deterministically toward 90% while the iframe loads and completes on its load
// event. A cross-origin frame exposes no byte-level progress, so this stays deliberately coarse:
// no fake percentage is shown — only the moving bar itself.
const PROGRESS_TICK_MS = 400
const PROGRESS_STEP = 6
const PROGRESS_CEILING = 90

type WebPreviewSurfaceProps = {
  url: string
  title: string
  isActive: boolean
}

const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

const isHttpUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

export const WebPreviewSurface = ({
  url,
  title,
  isActive
}: WebPreviewSurfaceProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [progress, setProgress] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // Reset for each URL change so re-pointing a tab restarts the indicator.
  useEffect(() => {
    // Defer the reset past the effect phase (avoids cascading-render warning).
    const handle = window.setTimeout(() => {
      setProgress(0)
      setLoaded(false)
    }, 0)
    return () => window.clearTimeout(handle)
  }, [url])

  useEffect(() => {
    if (!isActive || loaded) return

    const timer = window.setInterval(() => {
      setProgress((current) => Math.min(current + PROGRESS_STEP, PROGRESS_CEILING))
    }, PROGRESS_TICK_MS)

    return () => window.clearInterval(timer)
  }, [isActive, loaded, url])

  const handleLoad = useCallback(() => {
    setLoaded(true)
    setProgress(100)
  }, [])

  const openExternally = useCallback(() => {
    window.open(url, '_blank', 'noreferrer')
  }, [url])

  if (!isHttpUrl(url)) {
    return (
      <div className="flex size-full items-center justify-center p-6 text-center text-[13px] text-text-300">
        {t('ws.webPreviewUnsupported')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden" data-web-preview-url={url}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Globe2 className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-text-200" title={url}>
          <span className="font-medium text-text-100">{getHostname(url)}</span>
          <span className="ml-2 text-text-300">{url}</span>
        </span>
        <button
          type="button"
          className="shrink-0 rounded-sm p-1 text-text-300 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={openExternally}
          aria-label={t('ws.webPreviewOpenExternal')}
          title={t('ws.webPreviewOpenExternal')}
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      {/* The indicator doubles as the header bottom border while loading, then disappears. */}
      <div
        className={cn('h-[2px] shrink-0 overflow-hidden bg-transparent', !loaded && 'bg-bg-200')}
        role="progressbar"
        aria-hidden="true"
      >
        {!loaded ? (
          <div
            className="h-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${progress}%`, opacity: progress >= PROGRESS_CEILING ? 0.55 : 1 }}
          />
        ) : null}
      </div>
      <iframe
        ref={iframeRef}
        key={url}
        src={url}
        title={title}
        className="min-h-0 flex-1 border-0 bg-white"
        // No allow-same-origin: the framed document must not share any origin with the app.
        // No allow-top-navigation: it cannot redirect the workspace.
        // allow-popups lets target=_blank links reach the main process navigation policy,
        // which routes allowed HTTPS URLs to the system browser.
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        onLoad={handleLoad}
      />
    </div>
  )
}
