import { useState } from 'react'
import { Bookmark, GitBranch, Pin, PinOff, X } from 'lucide-react'

import { useLanguage } from '@/i18n'
import {
  buildSessionFork,
  planSessionFork,
  type SessionForkManifest
} from '../../../../shared/session-fork'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import type { ChatSession } from '@/stores/session-store'

// The session information card: what this conversation is, when it started and last moved, how much
// it holds, and a way into its evidence. Counts are computed from the same messages the transcript
// renders and are labelled as such, so the card can never disagree with what the reader sees.
//
// The pin is renderer-local state (localStorage), because it is a view preference and not part of the
// durable session record.

const PIN_STORAGE_PREFIX = 'purescience.sessionInfoCard.pinned.'

const readPinned = (sessionId: string): boolean => {
  try {
    return window.localStorage.getItem(`${PIN_STORAGE_PREFIX}${sessionId}`) === 'true'
  } catch {
    return false
  }
}

const writePinned = (sessionId: string, pinned: boolean): void => {
  try {
    window.localStorage.setItem(`${PIN_STORAGE_PREFIX}${sessionId}`, pinned ? 'true' : 'false')
  } catch {
    // A view preference that cannot be stored is not worth failing a render over.
  }
}

const formatTimestamp = (value: number | undefined, locale: string): string =>
  typeof value === 'number' ? new Date(value).toLocaleString(locale) : '—'

export function SessionInfoCard({
  session,
  onOpenEvidence,
  onClose
}: {
  session: ChatSession
  onOpenEvidence?: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useLanguage()
  // The pin is read once per mounted card; the mount site keys the card by session id, so switching
  // sessions remounts it rather than needing an effect to re-read the preference.
  const [pinned, setPinned] = useState(() => readPinned(session.id))
  // Forking is a two-step act on purpose: measure, show the numbers, then copy. Nothing is written
  // until the reader has seen what the copy will hold and what it will leave behind.
  const [forkManifest, setForkManifest] = useState<SessionForkManifest | undefined>(undefined)
  const [forkSource, setForkSource] = useState<PersistedChatSession | undefined>(undefined)
  const [forkNotice, setForkNotice] = useState<string | undefined>(undefined)
  const [forkBusy, setForkBusy] = useState(false)

  const handleMeasureFork = async (): Promise<void> => {
    setForkBusy(true)
    setForkNotice(undefined)
    try {
      const document = await window.api.sessions.readDocument({
        projectId: session.projectId,
        sessionId: session.id
      })
      if (!document) {
        setForkNotice(t('sessionFork.unreadable'))
        return
      }
      setForkSource(document)
      setForkManifest(planSessionFork(document))
    } catch (cause) {
      setForkNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setForkBusy(false)
    }
  }

  const handleConfirmFork = async (): Promise<void> => {
    if (!forkSource) return
    setForkBusy(true)
    try {
      const { session: forked } = buildSessionFork(forkSource, {
        newId: () => crypto.randomUUID(),
        now: () => Date.now()
      })
      await window.api.sessions.saveSession(forked, undefined)
      setForkNotice(t('sessionFork.done'))
      setForkManifest(undefined)
      setForkSource(undefined)
    } catch (cause) {
      setForkNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setForkBusy(false)
    }
  }

  const agentMessages = session.messages.filter((message) => message.role === 'agent').length
  const artifactKeys = new Set<string>()
  for (const message of session.messages) {
    const artifacts = (message as { artifacts?: { id?: string; name?: string }[] }).artifacts ?? []
    for (const artifact of artifacts) {
      artifactKeys.add(artifact.id ?? artifact.name ?? `${artifactKeys.size}`)
    }
  }
  const locale = navigator.language || 'en'

  const rows: { label: string; value: string }[] = [
    { label: t('sessionInfo.status'), value: session.status },
    { label: t('sessionInfo.messages'), value: String(session.messages.length) },
    { label: t('sessionInfo.assistantReplies'), value: String(agentMessages) },
    { label: t('sessionInfo.artifacts'), value: String(artifactKeys.size) },
    { label: t('sessionInfo.created'), value: formatTimestamp(session.createdAt, locale) },
    { label: t('sessionInfo.updated'), value: formatTimestamp(session.updatedAt, locale) }
  ]

  return (
    <div
      role="dialog"
      aria-label={t('sessionInfo.title')}
      data-slot="session-info-card"
      data-pinned={pinned ? 'true' : 'false'}
      className="absolute left-4 top-12 z-40 w-[320px] rounded-xl border border-border bg-bg-00 p-3 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-text-000" title={session.title}>
            {session.title}
          </p>
          {session.description ? (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-text-300">
              {session.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={pinned ? t('sessionInfo.unpin') : t('sessionInfo.pin')}
            title={pinned ? t('sessionInfo.unpin') : t('sessionInfo.pin')}
            onClick={() => {
              const next = !pinned
              setPinned(next)
              writePinned(session.id, next)
            }}
          >
            {pinned ? (
              <Pin className="size-3.5" strokeWidth={2} aria-hidden="true" />
            ) : (
              <PinOff className="size-3.5" strokeWidth={2} aria-hidden="true" />
            )}
          </button>
          <button type="button" aria-label={t('sessionInfo.close')} onClick={onClose}>
            <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-2">
            <dt className="text-text-300">{row.label}</dt>
            <dd className="truncate text-text-000 tabular-nums" title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      {onOpenEvidence ? (
        <button
          type="button"
          className="mt-2 flex items-center gap-1 text-[11px] text-text-300 hover:text-text-000"
          onClick={() => {
            onOpenEvidence()
            onClose()
          }}
        >
          <Bookmark className="size-3" strokeWidth={2} aria-hidden="true" />
          {t('sessionInfo.evidence')}
        </button>
      ) : null}
      {/* Forking: the numbers come first, the copy second. */}
      <div className="mt-2 border-t border-border pt-2">
        {forkManifest ? (
          <div data-slot="session-fork-manifest" className="text-[11px]">
            <p className="text-text-300">{t('sessionFork.willHold')}</p>
            <ul className="mt-1 grid grid-cols-2 gap-x-3 text-text-000 tabular-nums">
              <li>
                {t('sessionFork.messages')}: {forkManifest.counts.messages}
              </li>
              <li>
                {t('sessionFork.agentReplies')}: {forkManifest.counts.agentReplies}
              </li>
              <li>
                {t('sessionFork.artifactRefs')}: {forkManifest.counts.artifactReferences}
              </li>
              <li>
                {t('sessionFork.uploads')}: {forkManifest.counts.uploads}
              </li>
            </ul>
            <p className="mt-1 text-text-300">
              {t('sessionFork.notCarried', { names: forkManifest.notCarried.join(', ') })}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                data-slot="session-fork-confirm"
                className="rounded border border-border px-2 py-1"
                disabled={forkBusy}
                onClick={() => void handleConfirmFork()}
              >
                {t('sessionFork.confirm')}
              </button>
              <button
                type="button"
                className="text-text-300 hover:text-text-000"
                onClick={() => {
                  setForkManifest(undefined)
                  setForkSource(undefined)
                }}
              >
                {t('sessionInfo.close')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-slot="session-fork-measure"
            className="flex items-center gap-1 text-[11px] text-text-300 hover:text-text-000"
            disabled={forkBusy}
            title={t('sessionFork.measureHint')}
            onClick={() => void handleMeasureFork()}
          >
            <GitBranch className="size-3" strokeWidth={2} aria-hidden="true" />
            {t('sessionFork.action')}
          </button>
        )}
        {forkNotice ? (
          <p className="mt-1 text-[10px] text-text-300" role="status">
            {forkNotice}
          </p>
        ) : null}
      </div>
    </div>
  )
}
