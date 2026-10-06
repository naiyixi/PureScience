import { useEffect, useState } from 'react'
import { Bookmark, ClipboardCheck, GitBranch, Pin, PinOff, X } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { drainWorkspaceRuntimeEventsForPersistence } from '../../lib/acp/useWorkspaceAgentRuntime'
import { flushSessionPersistence } from '../../lib/session-persistence/session-persistence'
import {
  buildSessionFork,
  planSessionFork,
  type SessionForkManifest
} from '../../../../shared/session-fork'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { answerStepQuestion, type StepAnswer } from '../../../../shared/session-replay-answers'
import { buildSessionReplay, type SessionReplayStep } from '../../../../shared/session-replay-steps'
import type { ChatSession } from '@/stores/session-store'
import type { VisionEvidenceSummary } from '../../../../shared/vision-evidence'

// How many steps the card lists before it says how many more there are: this is an at-a-glance surface,
// and a long session would otherwise push everything else out of it.
const REPLAY_STEP_LIMIT = 12

// How much of a step's recorded terminal output the card shows; the full text belongs to the transcript.
const REPLAY_OUTPUT_EXCERPT = 80

// The session information card: what this conversation is, when it started and last moved, how much
// it holds, and a way into its evidence. Counts are computed from the same messages the transcript
// renders and are labelled as such, so the card can never disagree with what the reader sees.
//
// The pin is renderer-local state (localStorage), because it is a view preference and not part of the
// durable session record.

const PIN_STORAGE_PREFIX = 'purescience.sessionInfoCard.pinned.'

// The measured plan lives beside the pin, not in component state, for the same reason: the card is
// re-mounted while it is open (a session update re-renders the mount site), and a reader who has just
// measured a fork must not lose the numbers — or a notice they have not read yet — to a background
// update. Keyed by session, read on mount, written through on every change.
type SessionForkState = {
  manifest?: SessionForkManifest
  source?: PersistedChatSession
  notice?: string
}

const forkStates = new Map<string, SessionForkState>()

const readForkState = (sessionId: string): SessionForkState => forkStates.get(sessionId) ?? {}

const writeForkState = (sessionId: string, next: SessionForkState): void => {
  forkStates.set(sessionId, next)
}

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
  onOpenReview,
  onClose
}: {
  session: ChatSession
  onOpenEvidence?: () => void
  /** Opens the session's verification checklist / reviewer surface — reachable before any review exists. */
  onOpenReview?: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useLanguage()
  // The pin is read once per mounted card; the mount site keys the card by session id, so switching
  // sessions remounts it rather than needing an effect to re-read the preference.
  const [pinned, setPinned] = useState(() => readPinned(session.id))
  // IC36: which images this conversation had translated by the vision model, and under which extractor
  // generation and evidence schema. Read-only and payload-free by construction (see `VisionEvidenceSummary`).
  // `null` means "not known" — a failed read shows no section rather than an empty list that would read as
  // "this session translated nothing".
  const [visionEvidence, setVisionEvidence] = useState<VisionEvidenceSummary[] | null>(null)
  useEffect(() => {
    let alive = true
    void window.api?.diagnostics?.listVisionEvidence?.({ sessionId: session.id, limit: 20 })?.then(
      (rows) => {
        if (alive) setVisionEvidence(rows)
      },
      () => {
        if (alive) setVisionEvidence(null)
      }
    )
    return () => {
      alive = false
    }
  }, [session.id])
  // IC52 stage 1: the session's own steps, walked read-only. `null` means "not known" — a failed or
  // absent read shows no list rather than an empty one, which would read as "this session did nothing".
  const [replaySteps, setReplaySteps] = useState<SessionReplayStep[] | null>(null)
  useEffect(() => {
    let alive = true
    void window.api?.sessions
      ?.readDocument?.({ projectId: session.projectId, sessionId: session.id })
      ?.then(
        (document) => {
          if (!alive) return
          setReplaySteps(
            document
              ? buildSessionReplay({
                  messages: document.messages,
                  activities: document.activities
                })
              : null
          )
        },
        () => {
          if (alive) setReplaySteps(null)
        }
      )
    return () => {
      alive = false
    }
  }, [session.id, session.projectId])
  // IC52 stage 2: asking about one step. The answer is assembled locally from that step's own record (see
  // `answerStepQuestion`) — no model is consulted, so no answer can be invented — and a question the record
  // cannot answer is shown as exactly that instead of a plausible sentence.
  const [askStepId, setAskStepId] = useState('')
  const [askQuestion, setAskQuestion] = useState('')
  const [askAnswer, setAskAnswer] = useState<StepAnswer | null>(null)
  // Forking is a two-step act on purpose: measure, show the numbers, then copy. Nothing is written
  // until the reader has seen what the copy will hold and what it will leave behind. The measured
  // state is kept per session (see `forkStates`) so it survives the card being re-mounted.
  const [forkState, setForkState] = useState<SessionForkState>(() => readForkState(session.id))
  const [forkBusy, setForkBusy] = useState(false)

  // Escape closes the card while it is open, matching every other surface that can be dismissed.
  // The card is a non-modal popover, so it does not trap focus (the conversation stays reachable
  // behind it); it only claims the key when no dialog is stacked above, so Escape closes the
  // topmost layer first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]')) return
      onClose()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const updateForkState = (patch: Partial<SessionForkState>): void => {
    const next = { ...readForkState(session.id), ...patch }
    writeForkState(session.id, next)
    setForkState(next)
  }

  const handleMeasureFork = async (): Promise<void> => {
    setForkBusy(true)
    updateForkState({ notice: undefined })
    try {
      // Measure what the user can see. The transcript is persisted asynchronously, so reading the document
      // while a reply is still in flight reports a copy that omits it — the preview would under-count what is
      // already on screen (that is how the fork certification spec failed on a slow runner). Drain the runtime
      // events and flush first, the same sequence the quit handshake uses, so the counts describe the session
      // as it stands rather than as it happened to be written.
      await drainWorkspaceRuntimeEventsForPersistence()
      await flushSessionPersistence()
      const document = await window.api.sessions.readDocument({
        projectId: session.projectId,
        sessionId: session.id
      })
      if (!document) {
        updateForkState({ notice: t('sessionFork.unreadable') })
        return
      }
      updateForkState({ source: document, manifest: planSessionFork(document) })
    } catch (cause) {
      updateForkState({ notice: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setForkBusy(false)
    }
  }

  const handleConfirmFork = async (): Promise<void> => {
    const { source } = readForkState(session.id)
    if (!source) return
    setForkBusy(true)
    try {
      const { session: forked } = buildSessionFork(source, {
        newId: () => crypto.randomUUID(),
        now: () => Date.now()
      })
      await window.api.sessions.saveSession(forked, undefined)
      updateForkState({ manifest: undefined, source: undefined, notice: t('sessionFork.done') })
    } catch (cause) {
      updateForkState({ notice: cause instanceof Error ? cause.message : String(cause) })
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
      {visionEvidence && visionEvidence.length > 0 ? (
        <div className="mt-2" data-slot="session-info-vision-evidence">
          <div className="text-[11px] font-medium text-text-300">
            {t('sessionInfo.visionEvidence', { count: String(visionEvidence.length) })}
          </div>
          <ul className="mt-1 space-y-1">
            {visionEvidence.map((entry) => (
              <li
                key={entry.id}
                className="rounded border border-[var(--border)] px-2 py-1 text-[10px] text-text-300"
                data-slot="session-info-vision-evidence-item"
              >
                <span className="font-mono text-text-000">{entry.imageChecksum.slice(0, 12)}</span>{' '}
                · {entry.mimeType} ·{' '}
                {t('sessionInfo.visionExtractor', {
                  digest: entry.extractorFingerprint.slice(0, 12)
                })}{' '}
                · v{entry.evidenceSchemaVersion}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {replaySteps && replaySteps.length > 0 ? (
        <div className="mt-2" data-slot="session-replay-steps">
          <div className="text-[11px] font-medium text-text-300">
            {t('sessionInfo.replaySteps', { count: String(replaySteps.length) })}
          </div>
          <ol className="mt-1 space-y-1" data-slot="session-replay-step-list">
            {replaySteps.slice(0, REPLAY_STEP_LIMIT).map((step) => (
              <li
                key={step.id}
                className="rounded border border-[var(--border)] px-2 py-1 text-[10px] text-text-300"
                data-slot="replay-step"
                data-replay-step-kind={step.kind}
              >
                <span className="text-text-000">
                  {step.kind === 'prompt'
                    ? t('sessionInfo.replayPrompt')
                    : (step.toolName ?? step.title)}
                </span>
                {step.status ? ` · ${step.status}` : ''}
                {step.kind === 'tool' && !step.promptMessageId
                  ? ` · ${t('sessionInfo.replayUnattached')}`
                  : ''}
                {step.artifactIds.length > 0
                  ? ` · ${t('sessionInfo.replayArtifacts', { count: String(step.artifactIds.length) })}`
                  : ''}
                {step.locations && step.locations.length > 0
                  ? ` · ${t('sessionInfo.replayFiles', { count: String(step.locations.length) })}`
                  : ''}
                {step.terminalExitCode === undefined
                  ? ''
                  : ` · ${t('sessionInfo.replayExit', { code: String(step.terminalExitCode) })}`}
                {step.terminalOutput ? (
                  <span className="mt-0.5 block truncate font-mono text-text-400">
                    {step.terminalOutput.slice(0, REPLAY_OUTPUT_EXCERPT)}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          {replaySteps.length > REPLAY_STEP_LIMIT ? (
            <div className="mt-1 text-[10px] text-text-300" data-slot="session-replay-steps-more">
              {t('sessionInfo.replayStepsMore', {
                shown: String(REPLAY_STEP_LIMIT),
                total: String(replaySteps.length)
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {replaySteps && replaySteps.length > 0 ? (
        <div className="mt-2" data-slot="session-replay-ask">
          <div className="text-[11px] font-medium text-text-300">{t('sessionInfo.replayAsk')}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <select
              aria-label={t('sessionInfo.replayAskStep')}
              className="rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-[10px]"
              value={askStepId}
              onChange={(event) => {
                setAskStepId(event.target.value)
                setAskAnswer(null)
              }}
            >
              <option value="">{t('sessionInfo.replayAskStep')}</option>
              {replaySteps.map((step) => (
                <option key={step.id} value={step.id}>
                  {step.kind === 'prompt'
                    ? t('sessionInfo.replayPrompt')
                    : (step.toolName ?? step.title)}
                </option>
              ))}
            </select>
            <input
              aria-label={t('sessionInfo.replayAskQuestion')}
              placeholder={t('sessionInfo.replayAskQuestion')}
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-[10px]"
              value={askQuestion}
              onChange={(event) => setAskQuestion(event.target.value)}
            />
            <button
              type="button"
              data-slot="session-replay-ask-submit"
              className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] hover:text-text-000 disabled:opacity-50"
              disabled={askStepId === '' || askQuestion.trim() === ''}
              onClick={() => {
                const target = replaySteps.find((step) => step.id === askStepId)
                setAskAnswer(target ? answerStepQuestion(target, askQuestion) : null)
              }}
            >
              {t('sessionInfo.replayAskSubmit')}
            </button>
          </div>
          {askAnswer ? (
            askAnswer.topic === null ? (
              <p
                className="mt-1 text-[10px] text-text-400"
                data-slot="session-replay-ask-unanswered"
              >
                {t('sessionInfo.replayAskUnanswered')}
              </p>
            ) : (
              <ul className="mt-1 space-y-0.5" data-slot="session-replay-ask-answer">
                {askAnswer.facts.map((entry) => (
                  <li
                    key={entry.source}
                    className="text-[10px] text-text-300"
                    data-slot="replay-answer-fact"
                  >
                    {entry.recorded ? entry.value : t('sessionInfo.replayAskNotRecorded')}
                    {' · '}
                    <span className="font-mono text-text-400">
                      {t('sessionInfo.replayAskFrom', { source: entry.source })}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      ) : null}
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
      {onOpenReview ? (
        <button
          type="button"
          data-testid="session-info-open-review"
          aria-label={t('sessionInfo.review')}
          className="mt-2 flex items-center gap-1 text-[11px] text-text-300 hover:text-text-000"
          onClick={() => {
            onOpenReview()
            onClose()
          }}
        >
          <ClipboardCheck className="size-3" strokeWidth={2} aria-hidden="true" />
          {t('sessionInfo.review')}
        </button>
      ) : null}
      {/* Forking: the numbers come first, the copy second. */}
      <div className="mt-2 border-t border-border pt-2">
        {forkState.manifest ? (
          <div data-slot="session-fork-manifest" className="text-[11px]">
            <p className="text-text-300">{t('sessionFork.willHold')}</p>
            <ul className="mt-1 grid grid-cols-2 gap-x-3 text-text-000 tabular-nums">
              <li>
                {t('sessionFork.messages')}: {forkState.manifest.counts.messages}
              </li>
              <li>
                {t('sessionFork.agentReplies')}: {forkState.manifest.counts.agentReplies}
              </li>
              <li>
                {t('sessionFork.artifactRefs')}: {forkState.manifest.counts.artifactReferences}
              </li>
              <li>
                {t('sessionFork.uploads')}: {forkState.manifest.counts.uploads}
              </li>
            </ul>
            <p className="mt-1 text-text-300">
              {t('sessionFork.notCarried', { names: forkState.manifest.notCarried.join(', ') })}
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
                  updateForkState({ manifest: undefined, source: undefined })
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
        {forkState.notice ? (
          <p className="mt-1 text-[10px] text-text-300" role="status">
            {forkState.notice}
          </p>
        ) : null}
      </div>
    </div>
  )
}
