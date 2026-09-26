import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerVisibility
} from '@/components/ui/message-scroller'
// Bounded transcript rendering thresholds (see boundedRenderWindow below).
const BOUNDED_RENDER_ITEM_THRESHOLD = 150
const BOUNDED_RENDER_WINDOW_PADDING = 60

import {
  usePreviewWorkbenchStore,
  createSessionReviewerPreviewItem
} from '@/stores/preview-workbench-store'
import { selectProjectSessionReviews, useReviewStore } from '@/stores/review-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { groupRevisionsByRoot } from './revision-groups'
import { carriesSameTranscriptStructure } from './transcript-render-identity'
import { sameElements, stableArray, stableValue } from './stable-identity'
import { useLanguage } from '@/i18n'
import { flushSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'

import { getAgentLoadingPhase } from './agent-loading-message'
import {
  createPreviewFileItemFromArtifact,
  createPreviewFileItemFromMention,
  createPreviewFileItemFromUpload
} from './preview-file-item'
import { createPreviewRequestScope } from './previews/preview-file-reader'
import type { JobSummary } from '../../../../shared/compute'
import type { AnnotationImageRef, AnnotationRegion } from '../../../../shared/annotations'
import { CompletedJobCard } from '@/components/CompletedJobCard'
import { JobDetailModal } from '@/components/JobDetailModal'
import { extractJobIdFromActivity } from '@/components/job-binding-utils'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { ReviewerCard } from '@/components/ReviewerCard'
import { RunMarksRail } from './RunMarksRail'
import { MessageFocusConsumer } from './MessageFocusConsumer'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspacePlanActivityRecord } from './WorkspacePlanActivityRecord'
import { WorkspaceAgentLoadingRow } from './WorkspaceAgentLoadingRow'
import { EmptyConversationBanner } from './EmptyConversationBanner'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'
import type { ArtifactMentionPart } from './WorkspaceMessageItem'
import { useWorkspaceMessageEditState } from './workspace-message-edit-state-context'
import { createConversationItems } from './workspace-conversation-items'
import {
  selectLiveSessionActivities,
  selectLiveSessionActivityGroups
} from './activity-subscription'
import { groupConversationItems } from './workspace-tool-activity-groups'
import type { ActivityExpansionOverrides } from './workspace-tool-activity-groups'
import { useSessionJobStore } from '@/stores/session-job-store'
import type { GoToTranscriptIntent, ReviewWithChecks } from '../../../../shared/reviewer'
import type { ComposerDoc } from './composer/composer-doc'
import type {
  HandoffLifecycleEventSource,
  HandoffRetryRequest
} from '../../../../shared/handoff-lifecycle'
import { HandoffLifecycleStatus } from './HandoffLifecycleStatus'
import { useHandoffLifecycleEvents } from './useHandoffLifecycleEvents'
import { MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS } from '../../../../shared/artifacts'
import {
  createArtifactVersionLocator,
  type ArtifactVersionDescriptor
} from '../../../../shared/artifact-provenance'

type WorkspaceMessageScrollerProps = {
  activeSession: ChatSession | undefined
  onSendEditedMessage: (messageId: string, doc: ComposerDoc) => void
  canBranchInNewSession?: boolean
  onBranchInNewSession?: (messageId: string) => void
  // Region-annotation picks on agent images stage an image annotation card for the next message.
  onAnnotateImage?: (image: AnnotationImageRef, region: AnnotationRegion) => void
  // Events are read-only projections; retry sends an intent that main validates against its state.
  handoffLifecycleSource?: HandoffLifecycleEventSource
  onRetryHandoff?: (request: HandoffRetryRequest) => Promise<void>
}

type SessionScopedActivityGroupState = {
  sessionId: string | undefined
  groupIds: Set<string>
}

type SessionScopedActivityExpansionState = {
  sessionId: string | undefined
  overrides: ActivityExpansionOverrides
}

// Shared empty array: a slot with no revisions must keep the same identity across renders, otherwise it
// hands the message item a fresh array every chunk and defeats its memoisation.
type GraphMessage = NonNullable<ChatSession['conversationGraph']>['messages'][number]
const NO_REVISIONS: ReadonlyArray<GraphMessage> = []

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number] & {
  // A copied message owns no artifact metadata. Resolver results retain the Version's real owner so
  // the preview locator continues to address immutable source bytes rather than the new Session.
  resolvedProjectId?: string
  resolvedSessionId?: string
}
// User bubbles carry no artifacts; a shared empty array keeps their prop identity stable across chunks.
const NO_ARTIFACTS: MessageArtifact[] = []
type MessageUploadAttachment = NonNullable<ChatSession['messages'][number]['uploads']>[number]
const conversationContentClassName = 'relative mx-auto w-full max-w-4xl pb-[56px]'
// How long a "no longer available" mention notice stays visible before auto-dismissing.
const MENTION_NOTICE_TIMEOUT_MS = 3000

// Resolves a message's artifact ids against the session-level artifact metadata store.
const getMessageArtifacts = (
  session: ChatSession,
  message: ChatSession['messages'][number],
  resolvedArtifactsByVersionId?: ReadonlyMap<string, MessageArtifact | undefined>
): MessageArtifact[] => {
  if (!message.artifactIds) return []

  const artifactsById = new Map(
    (session.artifacts ?? []).map((artifact) => [artifact.id, artifact as MessageArtifact])
  )
  const artifactsByLogicalId = new Map<string, MessageArtifact>()

  for (const artifactId of message.artifactIds) {
    const artifact = artifactsById.get(artifactId) ?? resolvedArtifactsByVersionId?.get(artifactId)
    if (!artifact) continue

    const logicalId = artifact.versionId
      ? `version:${artifact.versionId}`
      : `artifact:${artifact.id}`
    const current = artifactsByLogicalId.get(logicalId)
    const isNativeVersion = Boolean(artifact.versionId && artifact.id === artifact.versionId)
    const currentIsNativeVersion = Boolean(current?.versionId && current.id === current.versionId)
    if (!current || (isNativeVersion && !currentIsNativeVersion)) {
      artifactsByLogicalId.set(logicalId, artifact)
    }
  }

  return Array.from(artifactsByLogicalId.values())
}

// Sends an app-managed generated file to the preview workbench instead of opening it locally.
const previewArtifact = (
  artifact: MessageArtifact,
  sessionId: string,
  projectId?: string
): void => {
  const previewItem = createPreviewFileItemFromArtifact(
    artifact,
    artifact.resolvedSessionId ?? sessionId,
    artifact.resolvedProjectId ?? projectId
  )

  // Generated files keep their artifact id so repeated clicks refresh the existing preview tab.
  if (previewItem) usePreviewWorkbenchStore.getState().upsertAndActivateItem(previewItem)
}

const isSafeVersionId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)

const toResolvedMessageArtifact = (descriptor: ArtifactVersionDescriptor): MessageArtifact => ({
  id: descriptor.versionId,
  artifactId: descriptor.artifactId,
  versionId: descriptor.versionId,
  versionNumber: descriptor.versionNumber,
  kind: 'managed-file',
  path: createArtifactVersionLocator({
    projectId: descriptor.projectName,
    appSessionId: descriptor.sessionId,
    artifactId: descriptor.artifactId,
    versionId: descriptor.versionId
  }),
  name: descriptor.name,
  mimeType: descriptor.mimeType,
  size: descriptor.size,
  mtimeMs: descriptor.mtimeMs,
  sha256: descriptor.checksum,
  resolvedProjectId: descriptor.projectName,
  resolvedSessionId: descriptor.sessionId
})

// Historical branch snapshots deliberately omit session.artifacts. Resolve only the Version ids
// their copied messages reference, cache the results for this mount, and leave legacy identifiers
// on the existing session-metadata path.
const useHistoricalArtifactDescriptors = (
  activeSession: ChatSession | undefined
): ReadonlyMap<string, MessageArtifact | undefined> => {
  const resolvedRef = useRef<{
    sessionId: string | undefined
    artifactsByVersionId: Map<string, MessageArtifact | undefined>
  }>({ sessionId: undefined, artifactsByVersionId: new Map() })
  const [resolved, setResolved] = useState<{
    sessionId: string | undefined
    artifactsByVersionId: ReadonlyMap<string, MessageArtifact | undefined>
  }>({ sessionId: undefined, artifactsByVersionId: new Map() })
  const [retryToken, setRetryToken] = useState(0)
  const retriedVersionIdsRef = useRef(new Set<string>())
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const sessionId = activeSession?.id
    if (resolvedRef.current.sessionId !== sessionId) {
      resolvedRef.current = { sessionId, artifactsByVersionId: new Map() }
      retriedVersionIdsRef.current.clear()
      setResolved(resolvedRef.current)
    }
    if (!activeSession || typeof window.api?.artifacts?.resolveVersionDescriptors !== 'function') {
      return
    }

    const cache = resolvedRef.current.artifactsByVersionId
    const storedArtifactIds = new Set(
      (activeSession.artifacts ?? []).map((artifact) => artifact.id)
    )
    const unresolvedVersionIds = [
      ...new Set(activeSession.messages.flatMap((message) => message.artifactIds ?? []))
    ].filter(
      (versionId) =>
        !storedArtifactIds.has(versionId) && !cache.has(versionId) && isSafeVersionId(versionId)
    )
    if (unresolvedVersionIds.length === 0) return

    // Claim ids before the first await so a rerender/StrictMode pass cannot issue duplicate IPC.
    for (const versionId of unresolvedVersionIds) cache.set(versionId, undefined)

    void (async () => {
      for (
        let index = 0;
        index < unresolvedVersionIds.length;
        index += MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS
      ) {
        const versionIds = unresolvedVersionIds.slice(
          index,
          index + MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS
        )
        try {
          const descriptors = await window.api.artifacts.resolveVersionDescriptors({
            projectId: activeSession.projectId,
            appSessionId: activeSession.id,
            versionIds
          })
          for (const descriptor of descriptors) {
            cache.set(descriptor.versionId, toResolvedMessageArtifact(descriptor))
          }
        } catch {
          // Failed lookups are retryable; only a successful response can confirm a missing Version.
          let shouldRetry = false
          for (const versionId of versionIds) {
            cache.delete(versionId)
            if (!retriedVersionIdsRef.current.has(versionId)) {
              retriedVersionIdsRef.current.add(versionId)
              shouldRetry = true
            }
          }
          if (shouldRetry) {
            // A freshly bound child can render before its queued Session save establishes ownership
            // in main. Retry only after that persistence queue settles instead of racing a timer.
            await flushSessionPersistence()
            if (
              mountedRef.current &&
              resolvedRef.current.sessionId === sessionId &&
              resolvedRef.current.artifactsByVersionId === cache
            ) {
              setRetryToken((token) => token + 1)
            }
          }
        }
      }
      if (
        mountedRef.current &&
        resolvedRef.current.sessionId === sessionId &&
        resolvedRef.current.artifactsByVersionId === cache
      ) {
        setResolved({ sessionId, artifactsByVersionId: new Map(cache) })
      }
    })()
  }, [activeSession, retryToken])

  return resolved.sessionId === activeSession?.id ? resolved.artifactsByVersionId : new Map()
}

// Sends an app-managed uploaded file to the preview workbench.
const previewUploadAttachment = (
  attachment: MessageUploadAttachment,
  sessionId: string,
  projectId?: string
): void => {
  // Upload ids are namespaced away from artifact ids while preserving one tab per uploaded file.
  usePreviewWorkbenchStore
    .getState()
    .upsertAndActivateItem(createPreviewFileItemFromUpload(attachment, sessionId, projectId))
}

// Opens the Session reviewer panel in the preview workbench, positioned at the finding's locator.
const openSessionReviewer = (sessionId: string, intent: GoToTranscriptIntent): void => {
  usePreviewWorkbenchStore.getState().upsertAndActivateItem(
    createSessionReviewerPreviewItem({
      sessionId,
      reviewId: intent.reviewId,
      findingId: intent.findingId,
      locator: intent.locator
    })
  )
}

type WorkspaceMessageReviewProps = {
  projectId: string | undefined
  sessionId: string
  turnMessageId: string
  onGoToTranscript: (intent: GoToTranscriptIntent) => void
  onRerun: (review: ReviewWithChecks) => Promise<boolean>
}

// Keep reviewer updates local to their card. Subscribing the transcript parent to the whole Session
// review array made every reviewer push rebuild every rich Markdown message in large conversations.
const WorkspaceMessageReview = ({
  projectId,
  sessionId,
  turnMessageId,
  onGoToTranscript,
  onRerun
}: WorkspaceMessageReviewProps): React.JSX.Element | null => {
  const review = useReviewStore((state) =>
    selectProjectSessionReviews(state.reviewsBySession, projectId, sessionId).find(
      (candidate) => candidate.turnMessageId === turnMessageId
    )
  )

  if (!review) return null
  return (
    <div className="px-4 pb-1 md:px-6">
      <div className="mx-auto w-full max-w-[56rem]">
        {/* Only "Go to transcript" navigates to the reviewer page; the card itself does not. */}
        <ReviewerCard review={review} onGoToTranscript={onGoToTranscript} onRerun={onRerun} />
      </div>
    </div>
  )
}

type EditableWorkspaceMessageItemProps = Omit<
  ComponentProps<typeof WorkspaceMessageItem>,
  'canEditMessage'
>

// Only user-message edit controls subscribe to review-sensitive edit availability. Agent rows remain
// outside this context subscription, so a reviewer lifecycle transition cannot rebuild rich output.
const EditableWorkspaceMessageItem = (
  props: EditableWorkspaceMessageItemProps
): React.JSX.Element => {
  const canEditMessage = useWorkspaceMessageEditState()
  return <WorkspaceMessageItem {...props} canEditMessage={canEditMessage} />
}

// Owns transcript scrolling and session-scoped expansion state for activity groups.
// Provider-scoped transcript body: the visibility hook MUST run inside MessageScrollerProvider,
// so this tiny wrapper lives under it and hands the computed bounded window back to the impl's
// render callback (which keeps all of the impl's closures). Without this split the hook threw
// "useMessageScroller must be used within a MessageScroller" and the workspace white-screened.
const WorkspaceMessageScrollerInner = ({
  conversationItems,
  render
}: {
  conversationItems: ReturnType<typeof groupConversationItems>
  render: (boundedRenderWindow: { first: number; last: number } | null) => React.ReactNode
}): React.JSX.Element => {
  const { visibleMessageIds } = useMessageScrollerVisibility()
  const boundedRenderWindow = useMemo(() => {
    if (conversationItems.length <= BOUNDED_RENDER_ITEM_THRESHOLD) return null
    const visible = new Set(visibleMessageIds)
    let firstVisible = -1
    let lastVisible = -1
    for (let index = 0; index < conversationItems.length; index += 1) {
      if (!visible.has(conversationItems[index].id)) continue
      if (firstVisible === -1) firstVisible = index
      lastVisible = index
    }
    if (firstVisible === -1) return null
    return {
      first: Math.max(0, firstVisible - BOUNDED_RENDER_WINDOW_PADDING),
      last: Math.min(conversationItems.length - 1, lastVisible + BOUNDED_RENDER_WINDOW_PADDING)
    }
  }, [conversationItems, visibleMessageIds])

  return <>{render(boundedRenderWindow)}</>
}

const WorkspaceMessageScrollerImpl = ({
  activeSession,
  onSendEditedMessage,
  canBranchInNewSession = false,
  onBranchInNewSession,
  onAnnotateImage,
  handoffLifecycleSource,
  onRetryHandoff
}: WorkspaceMessageScrollerProps): React.JSX.Element => {
  const { t } = useLanguage()
  const currentSessionId = activeSession?.id
  const currentProjectId = activeSession?.projectId
  const historicalArtifactsByVersionId = useHistoricalArtifactDescriptors(activeSession)
  const handoffEvents = useHandoffLifecycleEvents(handoffLifecycleSource, currentSessionId)
  // The whole-window find bar is an Electron overlay owned by main; the Workspace only needs to tell
  // main it is mounted and searchable so Cmd/Ctrl+F is intercepted (and re-arm UNREADY on unmount).
  useEffect(() => {
    const stop = window.api?.window?.announceWindowFindReady?.()
    return () => stop?.()
  }, [])
  const loadReviewsForSession = useReviewStore((state) => state.loadReviewsForSession)

  // Job store for binding and CompletedJobCard rendering
  const jobsById = useSessionJobStore((s) => s.jobsById)
  const hydrateJobs = useSessionJobStore((s) => s.hydrate)

  // Hydrate the job store when the active session changes
  useEffect(() => {
    // Guard against test environments where window.api.compute may not be available
    if (currentSessionId && typeof window.api?.compute?.jobsList === 'function') {
      void hydrateJobs(currentSessionId)
    }
  }, [currentSessionId, hydrateJobs])

  // Job detail modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [modalJob, setModalJob] = useState<JobSummary | undefined>(undefined)

  const handleOpenJobDetail = useCallback((job: JobSummary) => {
    setModalJob(job)
    setModalOpen(true)
  }, [])

  const handleCloseModal = useCallback(() => {
    setModalOpen(false)
  }, [])

  // Load persisted reviews whenever the active session changes.
  useEffect(() => {
    if (currentSessionId) {
      void loadReviewsForSession(currentSessionId, currentProjectId)
    }
  }, [currentProjectId, currentSessionId, loadReviewsForSession])

  // Reload (which recomputes staleness against current artifact bytes) when the window regains focus.
  // An artifact edited outside the app while this session stays open would otherwise keep showing its
  // review as current until the user switched sessions away and back; a focus return is the natural
  // moment an out-of-app edit could have happened.
  useEffect(() => {
    if (!currentSessionId) return

    const onFocus = (): void => {
      void loadReviewsForSession(currentSessionId, currentProjectId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [currentProjectId, currentSessionId, loadReviewsForSession])

  // Group expansion is keyed by session so switching conversations never reuses stale UI state.
  const [collapsedActivityGroupState, setCollapsedActivityGroupState] =
    useState<SessionScopedActivityGroupState>(() => ({
      sessionId: undefined,
      groupIds: new Set()
    }))
  // Individual detail rows default collapsed; overrides remember only explicit user toggles.
  const [activityExpansionOverrideState, setActivityExpansionOverrideState] =
    useState<SessionScopedActivityExpansionState>(() => ({
      sessionId: undefined,
      overrides: {}
    }))
  const collapsedActivityGroups =
    collapsedActivityGroupState.sessionId === currentSessionId
      ? collapsedActivityGroupState.groupIds
      : new Set<string>()
  const activityExpansionOverrides =
    activityExpansionOverrideState.sessionId === currentSessionId
      ? activityExpansionOverrideState.overrides
      : {}
  // Activities and their groups arrive several times a turn (every tool event, plus every status change), so
  // they are read from the store rather than from props — the same reason the streamed text is. The props
  // keep the frozen snapshot's values for isolated surfaces, which is the same fallback direction the text
  // channel uses. The comparators ignore both fields, so an activity update no longer re-mints the panel's
  // props: measured, one update used to re-render the panel and this container plus nine icons.
  const liveActivities = useSessionStore((state) =>
    selectLiveSessionActivities(state, currentSessionId)
  )
  const liveActivityGroups = useSessionStore((state) =>
    selectLiveSessionActivityGroups(state, currentSessionId)
  )
  // One object, memoised so the item assembly keeps its identity across a text chunk (the store's arrays do
  // too — the selectors above return the same reference until an activity actually changes).
  const sessionForItems = useMemo(
    () =>
      activeSession === undefined
        ? undefined
        : {
            ...activeSession,
            activities: liveActivities ?? activeSession.activities,
            activityGroups: liveActivityGroups ?? activeSession.activityGroups
          },
    [activeSession, liveActivities, liveActivityGroups]
  )
  const conversationItems = useMemo(
    () =>
      groupConversationItems(
        createConversationItems(sessionForItems, handoffEvents),
        liveActivityGroups ?? sessionForItems?.activityGroups
      ),
    [sessionForItems, liveActivityGroups, handoffEvents]
  )
  // Revisions grouped once per render. This used to be filtered and sorted inside every message slot,
  // which made the transcript list quadratic in the number of messages per streaming chunk — the cost
  // showed up as the residual >50ms tasks at 45 turns.
  // Per-slot caches: a streaming chunk rebuilds this list, and anything it hands a slot that did not
  // actually change has to keep its identity, or the message item's memo never gets to skip it.
  const artifactsCacheRef = useRef(
    new Map<string, EditableWorkspaceMessageItemProps['artifacts']>()
  )
  const runtimeIdentityCacheRef = useRef(
    new Map<string, EditableWorkspaceMessageItemProps['runtimeIdentity']>()
  )
  const itemPropsCacheRef = useRef(
    new Map<string, { deps: readonly unknown[]; value: EditableWorkspaceMessageItemProps }>()
  )
  const previousRevisionsRef = useRef<Map<string, GraphMessage[]>>(undefined)
  // Read during render on purpose: the ref only ever holds the PREVIOUS grouping, and passing it in is
  // what keeps item/revision identities stable across streaming deltas (see stable-identity.ts). The
  // effect below is the only writer.
  // eslint-disable-next-line react-hooks/refs -- intentional previous-value read, updated in an effect
  const revisionsByRootMessageId = useMemo(() => {
    const grouped = groupRevisionsByRoot(
      activeSession?.conversationGraph?.messages ?? [],
      previousRevisionsRef.current
    )
    previousRevisionsRef.current = grouped
    return grouped
  }, [activeSession?.conversationGraph])
  // User turns in transcript order — the run-marks rail renders one dot per turn and jumps to it.
  const runMarkUserMessageIds = useMemo(
    () =>
      conversationItems
        .filter((item) => item.type === 'message' && item.message.role === 'user')
        .map((item) => item.id),
    [conversationItems]
  )
  // Assistant text can be split into several messages around tool calls. All fragments share the
  // prompt they respond to, but only the last visible fragment in that turn owns whole-turn metadata.
  // Legacy unlinked messages remain independent so older transcripts do not lose their timestamps.
  const assistantFooterMessageIds = useMemo(() => {
    const footerIds = new Set<string>()
    const footerIdByPromptMessageId = new Map<string, string>()

    for (const item of conversationItems) {
      if (item.type !== 'message' || item.message.role !== 'agent') continue

      const promptMessageId = item.message.responseToMessageId
      if (!promptMessageId) {
        footerIds.add(item.message.id)
        continue
      }

      const previousFooterId = footerIdByPromptMessageId.get(promptMessageId)
      if (previousFooterId) footerIds.delete(previousFooterId)
      footerIdByPromptMessageId.set(promptMessageId, item.message.id)
      footerIds.add(item.message.id)
    }

    return footerIds
  }, [conversationItems])
  const agentLoadingPhase = getAgentLoadingPhase(activeSession)
  const messageCreatedAtById = new Map(
    activeSession?.messages.map((message) => [message.id, message.createdAt]) ?? []
  )

  // Counts the user turns after each message; the destructive-resend warning keys off turns, not
  // raw message count, so a single follow-up turn stays warning-free.
  const subsequentTurnCountByMessageId = new Map<string, number>()
  if (activeSession) {
    let subsequentTurns = 0
    for (let index = activeSession.messages.length - 1; index >= 0; index -= 1) {
      const message = activeSession.messages[index]
      subsequentTurnCountByMessageId.set(message.id, subsequentTurns)
      if (message.role === 'user') subsequentTurns += 1
    }
  }

  // Build a map from job_id → JobSummary for all session jobs (used in binding)
  const sessionJobs = useMemo((): JobSummary[] => {
    if (!currentSessionId) return []
    return Array.from(jobsById.values()).filter((j) => j.session_id === currentSessionId)
  }, [jobsById, currentSessionId])

  // Build a map from activity_id → JobSummary for quick lookup in WorkspaceActivityGroup
  // Also track which job_ids are bound to activities so we know which are unbound (CompletedJobCard)
  const { jobsByActivityId, boundJobIds } = useMemo(() => {
    const byActivityId = new Map<string, JobSummary>()
    const bound = new Set<string>()

    const allActivities = liveActivities ?? activeSession?.activities ?? []
    for (const job of sessionJobs) {
      // Scan all activities for this job_id
      for (const activity of allActivities) {
        const extracted = extractJobIdFromActivity(activity)
        if (extracted === job.job_id) {
          byActivityId.set(job.job_id, job)
          bound.add(job.job_id)
          break // Found — no need to scan further activities for this job
        }
      }
    }

    return { jobsByActivityId: byActivityId, boundJobIds: bound }
  }, [sessionJobs, liveActivities, activeSession?.activities])

  // Unbound completed jobs: jobs not found in any activity rawOutput — go into timeline
  const unboundCompletedJobs = useMemo((): JobSummary[] => {
    const terminalStatuses = new Set(['success', 'failed', 'timeout', 'error'])
    return sessionJobs.filter((j) => !boundJobIds.has(j.job_id) && terminalStatuses.has(j.status))
  }, [sessionJobs, boundJobIds])

  // Assign each unbound completed job to exactly one slot in the conversation timeline so
  // it is rendered at most once.  A job is placed immediately before the first conversation
  // item whose createdAt is GREATER than the job's created_at; if no such item exists the
  // job falls into the "trailing" slot rendered after all conversation items.
  //
  // Using an index-keyed Map (item index → jobs[]) instead of per-render filter on the full
  // array is the key correctness fix: every job is consumed by a single pass and never
  // re-matched against later items.
  const { jobSlotsByItemIndex, trailingJobs } = useMemo(() => {
    const sorted = [...unboundCompletedJobs].sort((a, b) => a.created_at - b.created_at)
    const byIndex = new Map<number, JobSummary[]>()
    const trailing: JobSummary[] = []

    for (const job of sorted) {
      // Find the first conversation item strictly after this job's timestamp.
      const insertBeforeIndex = conversationItems.findIndex(
        (item) => item.createdAt > job.created_at
      )
      if (insertBeforeIndex === -1) {
        // No later item — job goes in the trailing slot.
        trailing.push(job)
      } else {
        const existing = byIndex.get(insertBeforeIndex) ?? []
        existing.push(job)
        byIndex.set(insertBeforeIndex, existing)
      }
    }

    return { jobSlotsByItemIndex: byIndex, trailingJobs: trailing }
  }, [unboundCompletedJobs, conversationItems])

  // Transient "no longer available" pill shown when a mention target can't be opened.
  const [mentionNotice, setMentionNotice] = useState<string | null>(null)
  const mentionNoticeTimerRef = useRef<number | undefined>(undefined)

  // Clears any pending auto-dismiss timer so unmounting never fires setState on a dead component.
  useEffect(
    () => () => {
      if (mentionNoticeTimerRef.current !== undefined) {
        window.clearTimeout(mentionNoticeTimerRef.current)
      }
    },
    []
  )

  // Shows a transient notice and schedules its auto-dismiss, replacing any in-flight timer.
  // Stable identity: the mention handlers below depend on it, and those are part of the transcript
  // slot's prop set — a fresh closure here would rebuild every slot's props on every streaming chunk.
  const showMentionNotice = useCallback((message: string): void => {
    if (mentionNoticeTimerRef.current !== undefined) {
      window.clearTimeout(mentionNoticeTimerRef.current)
    }

    setMentionNotice(message)
    mentionNoticeTimerRef.current = window.setTimeout(() => {
      setMentionNotice(null)
      mentionNoticeTimerRef.current = undefined
    }, MENTION_NOTICE_TIMEOUT_MS)
  }, [])

  // Routes a generated-file click to the preview workbench, scoped to the active session.
  // Stable identity matters here: the transcript slot's props are compared by identity, and a fresh
  // closure per render would make every slot re-render on every streaming chunk.
  const onPreviewArtifact = useCallback(
    (artifact: MessageArtifact): void => {
      if (currentSessionId) previewArtifact(artifact, currentSessionId, currentProjectId)
    },
    [currentProjectId, currentSessionId, previewArtifact]
  )

  // Routes a sent-message upload click to the preview workbench for the active session.
  const onPreviewUploadAttachment = useCallback(
    (attachment: MessageUploadAttachment): void => {
      if (currentSessionId) {
        previewUploadAttachment(attachment, currentSessionId, activeSession?.projectId)
      }
    },
    [activeSession?.projectId, currentSessionId, previewUploadAttachment]
  )

  // Opens an artifact mention in the preview panel, probing existence first so a stale link warns.
  const onPreviewMentionArtifact = useCallback(
    async (part: ArtifactMentionPart): Promise<void> => {
      if (!currentSessionId) return
      if (part.source === 'linked-folder') {
        showMentionNotice('Linked-folder files are not available until the folder is connected.')
        return
      }

      const read =
        part.source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview

      try {
        await read({
          ...createPreviewRequestScope({
            projectId: currentProjectId,
            sessionId: currentSessionId,
            source: part.source,
            path: part.path
          }),
          path: part.path,
          maxBytes: 1,
          encoding: 'utf8'
        })
      } catch {
        showMentionNotice(`"${part.name}" is no longer available.`)
        return
      }

      usePreviewWorkbenchStore
        .getState()
        .upsertAndActivateItem(
          createPreviewFileItemFromMention(part, currentSessionId, currentProjectId)
        )
    },
    [currentProjectId, currentSessionId, showMentionNotice]
  )

  // Opens Settings on a skill mention's detail, warning instead when the skill no longer exists.
  const onOpenSkillMention = useCallback(
    async (skillId: string, name: string): Promise<void> => {
      const detail = await window.api.settings.getSkillDetail(skillId).catch(() => null)

      if (!detail) {
        showMentionNotice(`Skill "${name}" is no longer available.`)
        return
      }

      useSettingsStore.getState().openSettingsToSkill(skillId)
    },
    [showMentionNotice]
  )

  // # session-reference pill navigation: switch the workspace to the referenced session.
  const onOpenSessionMention = useCallback((sessionId: string): void => {
    const selectSession = useSessionStore.getState().selectSession
    if (useSessionStore.getState().sessions.some((session) => session.id === sessionId)) {
      selectSession(sessionId)
    }
  }, [])

  // Toggles a whole adjacent tool-activity group without affecting other sessions.
  const toggleActivityGroup = (groupId: string): void => {
    setCollapsedActivityGroupState((currentState) => {
      const currentGroupIds =
        currentState.sessionId === currentSessionId ? currentState.groupIds : new Set<string>()
      const nextGroupIds = new Set(currentGroupIds)

      if (nextGroupIds.has(groupId)) {
        nextGroupIds.delete(groupId)
      } else {
        nextGroupIds.add(groupId)
      }

      return {
        sessionId: currentSessionId,
        groupIds: nextGroupIds
      }
    })
  }

  // Records the user's explicit expansion choice for a single tool-activity detail row.
  const toggleActivityRow = (activityId: string, nextExpanded: boolean): void => {
    setActivityExpansionOverrideState((currentState) => {
      const currentOverrides =
        currentState.sessionId === currentSessionId ? currentState.overrides : {}

      return {
        sessionId: currentSessionId,
        overrides: {
          ...currentOverrides,
          [activityId]: nextExpanded
        }
      }
    })
  }

  // Opens the Session reviewer panel positioned at the finding the user clicked.
  // Only the "Go to transcript" button on a finding fires this; clicking the card itself does not.
  const handleGoToTranscript = (intent: GoToTranscriptIntent): void => {
    if (!currentSessionId) return
    openSessionReviewer(currentSessionId, intent)
  }

  // Re-runs the review for a specific (stale) turn — the actionable refresh the stale notice offers.
  // Unlike the composer's last-turn-only "Request review", this reaches any turn's review. The row is
  // grouped under review.turnMessageId (so a fix-loop review refreshes in place), but the audited
  // content is review.scope.turnMessageId — the turn whose bytes actually changed. Fire-and-forget:
  // a fresh review supersedes the stale one via reviewer:updated; concurrent runs are deduped in main.
  const handleRerunReview = async (review: ReviewWithChecks): Promise<boolean> => {
    try {
      const result = await window.api.reviewer.run({
        sessionId: review.sessionId,
        turnMessageId: review.turnMessageId,
        scopeTurnMessageId: review.scope.turnMessageId,
        projectId: review.projectId,
        mainSessionId: review.sessionId,
        model: useSettingsStore.getState().activeModel,
        // Explicit user Re-run: bypass main's auto-only per-turn idempotency so the stale/error review
        // is genuinely re-run rather than refused as already-reviewed.
        origin: 'manual'
      })
      return result?.started ?? false
    } catch {
      return false
    }
  }

  return (
    <>
      <MessageScrollerProvider
        key={activeSession?.id ?? 'empty-conversation'}
        autoScroll
        defaultScrollPosition="last-anchor"
        scrollPreviousItemPeek={64}
      >
        <MessageScroller className="relative min-h-0 flex-1 bg-bg-10">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-bg-10 to-bg-10/0"
          />
          {conversationItems.length === 0 ? <EmptyConversationBanner /> : null}
          <MessageScrollerViewport aria-label={t('wsMessage.conversation')}>
            <WorkspaceMessageScrollerInner
              conversationItems={conversationItems}
              render={(boundedRenderWindow) => (
                <MessageScrollerContent className="gap-0 px-4">
                  <div className={conversationContentClassName}>
                    {/* Messages and tool activities share one sorted transcript timeline. */}
                    {conversationItems.map((item, itemIndex) => {
                      // Far-off items collapse to a fixed-height skeleton placeholder. The window
                      // slides as the user scrolls, so approaching items render fully in time.
                      if (
                        boundedRenderWindow &&
                        (itemIndex < boundedRenderWindow.first ||
                          itemIndex > boundedRenderWindow.last)
                      ) {
                        return (
                          <MessageScrollerItem
                            key={item.id}
                            messageId={item.id}
                            className="min-w-0"
                            aria-hidden="true"
                          >
                            <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
                          </MessageScrollerItem>
                        )
                      }
                      if (item.type === 'message') {
                        const artifacts = stableArray(
                          artifactsCacheRef.current,
                          item.message.id,
                          activeSession && item.message.role !== 'user'
                            ? getMessageArtifacts(
                                activeSession,
                                item.message,
                                historicalArtifactsByVersionId
                              )
                            : NO_ARTIFACTS
                        )
                        // Jobs pre-assigned to this slot: each job appears in exactly one slot.
                        const jobsBeforeMessage = jobSlotsByItemIndex.get(itemIndex) ?? []
                        const graph = activeSession?.conversationGraph
                        const messageNode = graph?.messages.find(
                          (message) => message.id === item.message.id
                        )
                        const runtimeSegment = messageNode?.runtimeSegmentId
                          ? graph?.runtimeSegments.find(
                              (segment) => segment.id === messageNode.runtimeSegmentId
                            )
                          : undefined
                        // Legacy sessions synthesize this segment with a fallback framework. Keep only
                        // the session-level values that were actually persisted.
                        const synthesizedLegacyRuntime =
                          runtimeSegment?.id === `runtime-segment-${activeSession?.id}` &&
                          !activeSession?.agentFrameworkId
                        const runtimeIdentity = stableValue(
                          runtimeIdentityCacheRef.current,
                          item.message.id,
                          synthesizedLegacyRuntime
                            ? activeSession?.agentBackendId || activeSession?.agentModel
                              ? {
                                  backendId: activeSession.agentBackendId,
                                  model: activeSession.agentModel
                                }
                              : undefined
                            : runtimeSegment
                        )
                        const revisionRootMessageId = messageNode?.revisionRootMessageId
                        const revisions =
                          (revisionRootMessageId
                            ? revisionsByRootMessageId.get(revisionRootMessageId)
                            : undefined) ?? NO_REVISIONS
                        const revisionIndex = revisions.findIndex(
                          (message) => message.id === item.message.id
                        )
                        const activateRevision = (index: number): (() => void) | undefined => {
                          const revision = revisions[index]
                          return revision && activeSession
                            ? () =>
                                useSessionStore
                                  .getState()
                                  .activateMessageBranch(
                                    activeSession.id,
                                    revision.introducedOnBranchId
                                  )
                            : undefined
                        }
                        const showAssistantFooter =
                          item.message.role !== 'agent' ||
                          assistantFooterMessageIds.has(item.message.id)
                        const subsequentTurns =
                          subsequentTurnCountByMessageId.get(item.message.id) ?? 0
                        const turnStartedAt = item.message.responseToMessageId
                          ? messageCreatedAtById.get(item.message.responseToMessageId)
                          : undefined
                        // Everything this slot's props are built from. A real change makes the tuple differ
                        // and the bundle — closures included — is rebuilt, so a reused bundle can never serve
                        // stale values. The session is reduced to its id on purpose: the closures only read
                        // that, and keying on the session object would rebuild on every streaming chunk.
                        const propsDeps: readonly unknown[] = [
                          item.message,
                          artifacts,
                          runtimeIdentity,
                          revisionIndex,
                          revisions,
                          showAssistantFooter,
                          subsequentTurns,
                          turnStartedAt,
                          activeSession?.id,
                          onPreviewArtifact,
                          onPreviewUploadAttachment,
                          onOpenSkillMention,
                          onPreviewMentionArtifact,
                          onOpenSessionMention,
                          onAnnotateImage,
                          onSendEditedMessage,
                          canBranchInNewSession,
                          onBranchInNewSession
                        ]
                        const cachedProps = itemPropsCacheRef.current.get(item.message.id)
                        let messageItemProps: EditableWorkspaceMessageItemProps
                        if (cachedProps && sameElements(cachedProps.deps, propsDeps)) {
                          messageItemProps = cachedProps.value
                        } else {
                          messageItemProps = {
                            message: item.message,
                            // The message renders its own text from the store (see WorkspaceMessageItem):
                            // this container deliberately keeps its props across a streamed chunk, so the
                            // text must not travel through here.
                            sessionId: activeSession?.id,
                            onPreviewArtifact,
                            onPreviewUploadAttachment,
                            onOpenSkillMention,
                            onPreviewMentionArtifact,
                            onOpenSessionMention,
                            onAnnotateImage,
                            onSendEditedMessage,
                            canBranchInNewSession,
                            onBranchInNewSession,
                            turnStartedAt,
                            runtimeIdentity,
                            showAssistantFooter,
                            subsequentTurns,
                            revisionNavigation:
                              revisionIndex >= 0 && revisions.length > 1
                                ? {
                                    index: revisionIndex,
                                    total: revisions.length,
                                    onPrevious: activateRevision(revisionIndex - 1),
                                    onNext: activateRevision(revisionIndex + 1)
                                  }
                                : undefined,
                            artifacts
                          }
                          itemPropsCacheRef.current.set(item.message.id, {
                            deps: propsDeps,
                            value: messageItemProps
                          })
                        }

                        return (
                          <MessageScrollerItem
                            key={item.id}
                            messageId={item.message.id}
                            disableContainment
                            className="min-w-0"
                          >
                            <div>
                              {/* Unbound completed jobs that belong chronologically before this message */}
                              {jobsBeforeMessage.map((job) => (
                                <MessageScrollerItem
                                  key={`completed-job-${job.job_id}`}
                                  messageId={`completed-job-${job.job_id}`}
                                  className="min-w-0"
                                >
                                  <div className="px-4 py-1 md:px-6">
                                    <div className="mx-auto w-full max-w-4xl">
                                      <CompletedJobCard job={job} onOpen={handleOpenJobDetail} />
                                    </div>
                                  </div>
                                </MessageScrollerItem>
                              ))}
                              {item.message.role === 'user' ? (
                                <EditableWorkspaceMessageItem {...messageItemProps} />
                              ) : (
                                <WorkspaceMessageItem
                                  {...messageItemProps}
                                  canEditMessage={false}
                                />
                              )}
                              {currentSessionId && item.message.role === 'agent' ? (
                                <WorkspaceMessageReview
                                  projectId={currentProjectId}
                                  sessionId={currentSessionId}
                                  turnMessageId={item.message.id}
                                  onGoToTranscript={handleGoToTranscript}
                                  onRerun={handleRerunReview}
                                />
                              ) : null}
                            </div>
                          </MessageScrollerItem>
                        )
                      }

                      if (item.type === 'handoff') {
                        return (
                          <MessageScrollerItem
                            key={item.id}
                            messageId={item.id}
                            className="min-w-0"
                          >
                            <div className="px-4 pb-1 pt-3 md:px-6">
                              <div className="mx-auto w-full max-w-[56rem]">
                                <HandoffLifecycleStatus
                                  handoff={item}
                                  onRetry={
                                    item.phase === 'failed' && onRetryHandoff
                                      ? async () =>
                                          onRetryHandoff({
                                            sessionId: item.sessionId,
                                            originatingTurnId: item.originatingTurnId
                                          })
                                      : undefined
                                  }
                                />
                              </div>
                            </div>
                          </MessageScrollerItem>
                        )
                      }

                      if (item.type === 'plan-activity') {
                        return (
                          <WorkspacePlanActivityRecord key={item.id} activity={item.activity} />
                        )
                      }

                      if (item.type === 'config-change') {
                        return (
                          <MessageScrollerItem
                            key={item.id}
                            messageId={item.id}
                            className="min-w-0"
                          >
                            <div className="px-4 pt-2 md:px-6">
                              <div className="mx-auto flex w-full max-w-[56rem] items-center gap-3">
                                <span aria-hidden="true" className="h-px flex-1 bg-border" />
                                <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                  {t('ws.configChanged')}
                                </span>
                                {item.agentModel ? (
                                  <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                                    {item.agentModel}
                                  </span>
                                ) : null}
                                <span aria-hidden="true" className="h-px flex-1 bg-border" />
                              </div>
                            </div>
                          </MessageScrollerItem>
                        )
                      }

                      return (
                        <WorkspaceActivityGroup
                          key={item.id}
                          group={item}
                          isExpanded={!collapsedActivityGroups.has(item.id)}
                          onToggleGroup={toggleActivityGroup}
                          expansionOverrides={activityExpansionOverrides}
                          onToggleRow={toggleActivityRow}
                          jobsByActivityId={jobsByActivityId}
                          onOpenJobDetail={handleOpenJobDetail}
                        />
                      )
                    })}

                    {/* Render any remaining unbound completed jobs after all conversation items */}
                    {trailingJobs.map((job) => (
                      <MessageScrollerItem
                        key={`completed-job-${job.job_id}`}
                        messageId={`completed-job-${job.job_id}`}
                        className="min-w-0"
                      >
                        <div className="px-4 py-1 md:px-6">
                          <div className="mx-auto w-full max-w-4xl">
                            <CompletedJobCard job={job} onOpen={handleOpenJobDetail} />
                          </div>
                        </div>
                      </MessageScrollerItem>
                    ))}

                    {agentLoadingPhase !== 'hidden' && activeSession ? (
                      <WorkspaceAgentLoadingRow
                        sessionId={activeSession.id}
                        phase={agentLoadingPhase}
                      />
                    ) : null}
                  </div>
                </MessageScrollerContent>
              )}
            />
          </MessageScrollerViewport>

          <MessageScrollerButton className="z-10 border-border-200 bg-bg-000 shadow-card hover:bg-bg-200 data-[direction=end]:bottom-3" />

          {/* Run-marks rail: one dot per user turn; click to jump. Hidden below the turn threshold. */}
          <RunMarksRail userMessageIds={runMarkUserMessageIds} />

          {/* Lands on the message a palette content hit pointed at, once this session is mounted. */}
          {activeSession ? <MessageFocusConsumer sessionId={activeSession.id} /> : null}

          {/* Transient warning shown when a mention target no longer resolves to a file or skill. */}
          {mentionNotice ? (
            <div
              role="status"
              className="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center px-4"
            >
              <span className="rounded-full border border-border-200 bg-bg-000 px-3 py-1 text-[13px] text-text-100 shadow-card">
                {mentionNotice}
              </span>
            </div>
          ) : null}
        </MessageScroller>
      </MessageScrollerProvider>

      {/* Job detail modal — opened from RemoteJobRow or CompletedJobCard */}
      {currentSessionId && (
        <JobDetailModal
          open={modalOpen}
          sessionId={currentSessionId}
          initialJob={modalJob}
          onClose={handleCloseModal}
        />
      )}
    </>
  )
}

// Composer controls above the transcript react to reviewer lifecycle changes. Keep those parent
// renders from rebuilding an unchanged transcript; review cards maintain their own scoped subscription.
//
// The comparison ignores the streamed text of the turn that is currently running (`carriesSameTranscript
// Structure`): a chunk replaces the Session object every few characters, but the transcript's structure —
// which turns exist, their order, roles, statuses, attachments and artifacts — is unchanged, so this
// container must not re-walk the whole list for it. The streamed text reaches the one message that renders
// it through that message's own store subscription.
const areWorkspaceMessageScrollerPropsEqual = (
  previous: WorkspaceMessageScrollerProps,
  next: WorkspaceMessageScrollerProps
): boolean =>
  previous.onSendEditedMessage === next.onSendEditedMessage &&
  previous.onAnnotateImage === next.onAnnotateImage &&
  carriesSameTranscriptStructure(previous.activeSession, next.activeSession)

const WorkspaceMessageScroller = memo(
  WorkspaceMessageScrollerImpl,
  areWorkspaceMessageScrollerPropsEqual
)
WorkspaceMessageScroller.displayName = 'WorkspaceMessageScroller'

export { WorkspaceMessageScroller }
