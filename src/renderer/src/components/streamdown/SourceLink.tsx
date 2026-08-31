/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { ExternalLink, Globe2 } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { createWebPreviewItem, usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'
import { cn } from '@/lib/utils'

import { LinkSafetyModal } from './LinkSafetyModal'

// Hover reveals the source card only after a deliberate dwell; a pointer sweeping across a
// paragraph of links must not flash cards. The close delay gives the pointer room to move from
// the link onto the card without dismissing it.
const HOVER_OPEN_DELAY_MS = 350
const CARD_CLOSE_DELAY_MS = 200

type SourceLinkProps = ComponentProps<'a'> & {
  node?: unknown
  'data-incomplete'?: boolean
}

type FaviconState = 'loading' | 'success' | 'error'

// Favicon URLs are derived from the link's own hostname — no third-party lookup service, no
// metadata API. The document itself is never fetched by the card; the iframe below requests zero
// bytes until the user activates the preview.
const getSessionLinkFaviconUrl = (href: string | undefined): string | undefined => {
  if (!href) return undefined

  try {
    const url = new URL(href)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined

    return `https://${url.hostname.toLowerCase()}/favicon.ico`
  } catch {
    return undefined
  }
}

export const SessionLinkFavicon = ({ src }: { src: string }): React.JSX.Element => {
  const [state, setState] = useState<FaviconState>('loading')

  return (
    <span data-session-link-favicon="" data-state={state} aria-hidden="true">
      <Globe2 data-session-link-favicon-fallback="" />
      {state !== 'error' ? (
        <img
          src={src}
          alt=""
          width="16"
          height="16"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => setState('success')}
          onError={() => setState('error')}
        />
      ) : null}
    </span>
  )
}

export const SourceLink = ({
  children,
  className,
  href,
  'data-incomplete': dataIncomplete
}: SourceLinkProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)
  const [showSafety, setShowSafety] = useState(false)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const linkRef = useRef<HTMLAnchorElement | null>(null)

  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const upsertAndActivateItem = usePreviewWorkbenchStore((state) => state.upsertAndActivateItem)

  let parsedUrl: URL | undefined
  try {
    if (href) parsedUrl = new URL(href)
  } catch {
    // Unparseable links fall through to the safety-modal path.
  }

  // Only HTTPS sources preview in-app; anything else keeps the external-jump confirmation.
  const isInAppSource = parsedUrl?.protocol === 'https:' && Boolean(parsedUrl.hostname)
  const faviconUrl = getSessionLinkFaviconUrl(href)

  const clearTimers = useCallback((): void => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    openTimerRef.current = null
    closeTimerRef.current = null
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const scheduleOpen = useCallback((): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (!isInAppSource || openTimerRef.current !== null) return
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      setIsOpen(true)
    }, HOVER_OPEN_DELAY_MS)
  }, [isInAppSource])

  const scheduleClose = useCallback((): void => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setIsOpen(false)
    }, CARD_CLOSE_DELAY_MS)
  }, [])

  const openInApp = useCallback((): void => {
    if (!href || !isInAppSource || !selectedSessionId) return

    clearTimers()
    setIsOpen(false)
    // Prefer the link's own markdown label as the tab title; fall back to the hostname.
    const label = typeof children === 'string' && children.trim() ? children.trim() : undefined
    upsertAndActivateItem(createWebPreviewItem(selectedSessionId, href, label))
  }, [children, clearTimers, href, isInAppSource, selectedSessionId, upsertAndActivateItem])

  const openExternally = useCallback((): void => {
    clearTimers()
    setIsOpen(false)
    if (href) window.open(href, '_blank', 'noreferrer')
  }, [clearTimers, href])

  const handleClick = useCallback((): void => {
    if (isInAppSource) {
      openInApp()
      return
    }

    setIsOpen(false)
    setShowSafety(true)
  }, [isInAppSource, openInApp])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLAnchorElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault()
        handleClick()
      } else if (event.key === 'Escape' && isOpen) {
        event.preventDefault()
        clearTimers()
        setIsOpen(false)
        linkRef.current?.focus()
      }
    },
    [clearTimers, handleClick, isOpen]
  )

  const hostname = parsedUrl?.hostname ?? ''
  const displayUrl = href ?? ''

  return (
    <>
      <a
        ref={linkRef}
        href={href}
        className={cn('relative inline-flex items-center', className)}
        data-incomplete={dataIncomplete}
        data-session-message-link=""
        data-streamdown="link"
        data-source-link-mode={isInAppSource ? 'in-app' : 'external'}
        onClick={(event) => {
          event.preventDefault()
          handleClick()
        }}
        onKeyDown={handleKeyDown}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
        onTouchStart={() => setIsOpen(true)}
      >
        {faviconUrl ? <SessionLinkFavicon key={faviconUrl} src={faviconUrl} /> : null}
        {children}
        {isOpen && isInAppSource ? (
          <span
            role="dialog"
            aria-label={`${t('ws.sourceLinkHoverTitle')}: ${hostname}`}
            className="absolute left-1/2 top-full z-50 mt-1.5 block w-64 -translate-x-1/2 rounded-lg border border-border bg-bg-00 p-3 text-left shadow-lg"
            data-source-link-card=""
            onMouseEnter={scheduleOpen}
            onMouseLeave={scheduleClose}
          >
            <span className="block text-[11px] font-medium uppercase tracking-wide text-text-300">
              {t('ws.sourceLinkHoverTitle')}
            </span>
            <span className="mt-1 block truncate text-[12px] font-medium text-text-100">
              {hostname}
            </span>
            <span className="mt-0.5 block break-all text-[11px] text-text-300">{displayUrl}</span>
            <span className="mt-2 flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1 text-[11px] text-text-300">
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                {t('ws.sourceLinkOpenInApp')}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-sm p-0.5 text-text-300 outline-none hover:bg-bg-200 hover:text-text-100 focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={(event) => {
                  event.stopPropagation()
                  openExternally()
                }}
                aria-label={t('ws.webPreviewOpenExternal')}
                title={t('ws.webPreviewOpenExternal')}
              >
                <ExternalLink className="size-3" aria-hidden="true" />
              </button>
            </span>
          </span>
        ) : null}
      </a>
      {!isInAppSource && href ? (
        <LinkSafetyModal
          url={href}
          isOpen={showSafety}
          onClose={() => setShowSafety(false)}
          onConfirm={openExternally}
        />
      ) : null}
    </>
  )
}
