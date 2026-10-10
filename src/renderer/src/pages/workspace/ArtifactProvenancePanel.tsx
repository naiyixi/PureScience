import { ChevronLeft, ChevronRight, Circle, Download, LoaderCircle, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useLanguage, type TranslationKey } from '@/i18n'

import { Button } from '@/components/ui/button'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { ReviewerCard } from '@/components/ReviewerCard'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import {
  createSessionReviewerPreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type {
  NotebookInputFileSummary,
  NotebookOutput,
  NotebookRunRecord
} from '../../../../shared/notebook'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionProvenance,
  ProvenanceNotebookRun,
  ProvenanceMessage
} from '../../../../shared/artifact-provenance'
import type {
  ArtifactCodeReconstruction,
  ArtifactCodeReconstructionState
} from '../../../../shared/artifact-code-reconstruction'
import type { PersistedToolActivity } from '../../../../shared/session-persistence'
import type { GoToTranscriptIntent, ReviewUpdateEvent } from '../../../../shared/reviewer'
import type { ReadingVerification } from '../../../../shared/reading-fingerprint'
import { READING_FINGERPRINT_HASH_RECIPE } from '../../../../shared/reading-fingerprint'
import { formatBytes } from '../../../../shared/update'
import {
  createPreviewFileItemForArtifactVersion,
  resolveArtifactVersionDescriptor
} from './preview-file-item'
import { NotebookInputDataStrip } from './NotebookInputDataStrip'
import { NotebookCodeBlock } from './notebook-code'
import { NotebookDialogCell } from './SessionNotebookDialog'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspacePlanActivityRecord } from './WorkspacePlanActivityRecord'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'
import { createConversationItems } from './workspace-conversation-items'
import { groupConversationItems } from './workspace-tool-activity-groups'
import { ArtifactReplaySection } from './ArtifactReplaySection'

type ProvenanceTab =
  'code' | 'execution' | 'messages' | 'environment' | 'review' | 'readings' | 'replay'
type DeferredProvenanceTab = Extract<ProvenanceTab, 'execution' | 'messages' | 'review'>
type DeferredSection =
  | Pick<ArtifactVersionProvenance, 'execution'>
  | Pick<ArtifactVersionProvenance, 'messages'>
  | Pick<ArtifactVersionProvenance, 'review'>
type DeferredSectionResult =
  { state: 'loaded'; section: DeferredSection } | { state: 'error'; message: string }

type CodeReconstructionPanelState =
  | { status: 'loading' }
  | { status: 'loaded'; value: ArtifactCodeReconstructionState }
  | { status: 'generating'; previous: ArtifactCodeReconstructionState }
  | {
      status: 'error'
      message: string
      previous?: ArtifactCodeReconstructionState
    }

type ArtifactProvenancePanelProps = {
  item: PreviewFileItem
  projectId: string
  onClose: () => void
  onVersionChange?: (item: PreviewFileItem) => void
}

const tabs: Array<{ id: ProvenanceTab; label: TranslationKey }> = [
  { id: 'code', label: 'ws.code' },
  { id: 'execution', label: 'ws.executionLog' },
  { id: 'messages', label: 'ws.messages' },
  { id: 'environment', label: 'ws.environment' },
  { id: 'review', label: 'ws.review' },
  // The readings travel with the Version's own projection (no separate fetch): a reading that a report
  // number came from has to be readable in the window, and the journal is one small file read.
  { id: 'readings', label: 'ws.readings' },
  // Runs on demand: a replay executes the recorded version, so it never fires on tab selection.
  { id: 'replay', label: 'ws.replay' }
]

const tabActionBarClassName = 'flex items-center gap-3 border-b border-border-300/50 px-4 py-2'

const scriptDownloadFormats = {
  python: { extension: 'py', mimeType: 'text/x-python' },
  r: { extension: 'R', mimeType: 'text/x-r' },
  bash: { extension: 'sh', mimeType: 'text/x-sh' },
  repl: { extension: 'txt', mimeType: 'text/plain' }
} satisfies Record<ArtifactCodeReconstruction['language'], { extension: string; mimeType: string }>

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const toNotebookOutput = (output: ProvenanceNotebookRun['outputs'][number]): NotebookOutput => {
  if (output.type === 'error') {
    return { ...output, traceback: output.traceback?.join('\n') ?? '' }
  }
  if (output.type === 'omitted-media') {
    return { type: 'text', text: `[omitted media: ${output.mimeType}]` }
  }
  if (output.type === 'table') {
    return {
      type: 'json',
      data: output.previewRows.map((row) =>
        Object.fromEntries(output.columns.map((column, index) => [column, row[index]]))
      )
    }
  }
  return { type: 'text', text: output.text }
}

const toNotebookRun = (
  record: ProvenanceNotebookRun
): { run: NotebookRunRecord; index: number; scriptTruncated: boolean } => {
  return {
    index: record.runIndex,
    // Carried out of the projection rather than dropped: the stored script may be a clipped version of the
    // run's script, and the cell below shows (and the .ipynb export carries) that clipped text.
    scriptTruncated: record.scriptTruncated === true,
    run: {
      runId: record.runId,
      cellId: `provenance-${record.runId}`,
      source: 'agent',
      kernelKind: record.kernelKind,
      script: record.script,
      status: record.status,
      startedAt: Date.parse(record.startedAt) || 0,
      endedAt: record.completedAt ? Date.parse(record.completedAt) || undefined : undefined,
      executionCount: record.executionCount,
      environment: record.environmentName,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: record.outputs.map(toNotebookOutput),
      artifacts: [],
      workingFiles: []
    }
  }
}

const statusReason = (value: unknown): string | undefined => {
  const status = asRecord(value)
  return asString(status?.reason)
}

const codeReconstructionUnavailableLabel = (
  reason: Extract<ArtifactCodeReconstructionState, { state: 'unavailable' }>['reason'],
  t: (key: TranslationKey) => string
): string => {
  switch (reason) {
    case 'execution-unavailable':
      return t('ws.reconstructionNeedsExecutionLog')
    case 'producer-unavailable':
      return t('ws.producerRunNotIdentified')
    case 'producer-script-missing':
      return t('ws.producerRunNoScript')
  }
}

const packageKey = (value: string): string =>
  value.normalize('NFC').toLocaleLowerCase('und').replace(/[-_.]/gu, '')

const packageNameFromSpec = (value: string): string | undefined =>
  value.trim().match(/^[A-Za-z0-9_.-]+/u)?.[0]

const environmentWarningLabel = (warning: string, t: (key: TranslationKey) => string): string => {
  switch (warning) {
    case 'inventory-cache-best-effort':
      return t('ws.inventoryCacheReused')
    case 'environment-changed-during-run':
      return t('ws.environmentChangedDuringRun')
    default:
      return warning
  }
}

const packageChangeLabel = (change: Record<string, unknown>): string => {
  const name = asString(change.name) ?? 'unknown package'
  const before = asString(change.before_version)
  const after = asString(change.after_version)
  switch (asString(change.change)) {
    case 'installed':
      return `${name} ${after ?? '(version unavailable)'}`
    case 'updated':
      return `${name} ${before ?? '—'} → ${after ?? '—'}`
    case 'removed':
      return `${name} ${before ?? '(version unavailable)'} → removed`
    case 'unchanged':
    case 'observed':
      return `${name} ${after ?? before ?? '(version unavailable)'}`
    default:
      return name
  }
}

const toSourceLines = (source: string): string[] => source.match(/[^\n]*\n|[^\n]+$/gu) ?? []

const toNotebookOutputs = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) return []
  const outputs: Array<Record<string, unknown>> = []
  for (const candidate of value) {
    const output = asRecord(candidate)
    if (!output) continue
    const type = asString(output.type)
    if (type === 'error') {
      const traceback = Array.isArray(output.traceback)
        ? output.traceback.filter((line): line is string => typeof line === 'string')
        : []
      outputs.push({
        output_type: 'error',
        ename: asString(output.name) ?? 'Error',
        evalue: asString(output.message) ?? '',
        traceback
      })
      continue
    }
    if (type === 'omitted-media') {
      outputs.push({
        output_type: 'display_data',
        data: { 'text/plain': ['[Media omitted from immutable Provenance snapshot]'] },
        metadata: {}
      })
      continue
    }
    if (type === 'table') {
      outputs.push({
        output_type: 'display_data',
        data: { 'application/json': output.previewRows ?? [], 'text/plain': ['[Table preview]'] },
        metadata: {}
      })
      continue
    }
    const text = asString(output.text)
    if (text !== undefined) outputs.push({ output_type: 'stream', name: 'stdout', text })
  }
  return outputs
}

const buildExecutionNotebook = (
  runs: unknown[],
  kernel: 'python' | 'r',
  metadata: {
    artifactId: string
    versionId: string
    producerRunId?: string
    runtimeVersion?: string
  }
): Record<string, unknown> => ({
  cells: runs.flatMap((candidate) => {
    const run = asRecord(candidate)
    if (!run || asString(run.kernelKind) !== kernel) return []
    const script = asString(run.script)
    if (script === undefined) return []
    return [
      {
        cell_type: 'code',
        execution_count: typeof run.executionCount === 'number' ? run.executionCount : null,
        metadata: { purescience_run_id: asString(run.runId) },
        outputs: toNotebookOutputs(run.outputs),
        source: toSourceLines(script)
      }
    ]
  }),
  metadata: {
    kernelspec:
      kernel === 'python'
        ? { display_name: 'Python 3', language: 'python', name: 'python3' }
        : { display_name: 'R', language: 'R', name: 'ir' },
    language_info: {
      name: kernel,
      ...(metadata.runtimeVersion ? { version: metadata.runtimeVersion } : {})
    },
    purescience: {
      artifact_id: metadata.artifactId,
      artifact_version_id: metadata.versionId,
      producer_run_id: metadata.producerRunId,
      provenance_snapshot: true
    }
  },
  nbformat: 4,
  nbformat_minor: 5
})

type AvailableProvenanceMessages = Extract<
  ArtifactVersionProvenance['messages'],
  { state: 'available' }
>

const ignoreArtifactPreview = (): void => {}
const ignoreUploadPreview = (): void => {}
const ignoreSkillOpen = (): void => {}
const ignoreMentionPreview = (): void => {}

const toChatMessage = (message: ProvenanceMessage, sortIndex: number): ChatMessage => ({
  id: message.id,
  role: message.role,
  content: message.content,
  status: 'complete',
  eventIds: [],
  createdAt: message.createdAt,
  updatedAt: message.createdAt,
  sortIndex
})

const toToolActivity = (activity: PersistedToolActivity): ToolActivity => {
  const { toolKind, toolContent, ...persisted } = activity
  return {
    ...persisted,
    ...(toolKind ? { toolKind: toolKind as ToolActivity['toolKind'] } : {}),
    ...(toolContent ? { toolContent: toolContent as ToolActivity['toolContent'] } : {})
  }
}

// Replays immutable Message evidence through the same leaf renderers as the live Session transcript.
// Generated cards and navigation stay disabled because a snapshot is evidence, not a second Session.
const ProvenanceMessagesTimeline = ({
  snapshot,
  projectId,
  sessionId
}: {
  snapshot: AvailableProvenanceMessages
  projectId: string
  sessionId: string
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})
  const projectedById = useMemo(
    () => new Map(snapshot.items.map((message) => [message.id, message])),
    [snapshot.items]
  )
  const conversationItems = useMemo(() => {
    const session: ChatSession = {
      id: sessionId,
      projectId,
      title: t('ws.provenanceMessages'),
      cwd: '',
      status: 'idle',
      messages: snapshot.items.map(toChatMessage),
      activities: snapshot.activities.map(toToolActivity),
      activityGroups: snapshot.activityGroups,
      createdAt: snapshot.items[0]?.createdAt ?? 0,
      updatedAt: snapshot.items.at(-1)?.createdAt ?? 0
    }
    return groupConversationItems(createConversationItems(session), snapshot.activityGroups)
  }, [projectId, sessionId, snapshot, t])

  return (
    <MessageScrollerProvider
      key={`${sessionId}:${snapshot.items.at(-1)?.id ?? 'empty'}`}
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={64}
    >
      <MessageScroller className="min-h-0 bg-bg-000">
        <MessageScrollerViewport aria-label={t('ws.provenanceMessages')}>
          <MessageScrollerContent className="gap-0 px-4">
            <div className="mx-auto w-full max-w-4xl pb-4">
              {conversationItems.map((conversationItem) => {
                if (conversationItem.type === 'message') {
                  return (
                    <WorkspaceMessageItem
                      key={conversationItem.id}
                      message={conversationItem.message}
                      staticParts={projectedById.get(conversationItem.message.id)?.parts}
                      onPreviewArtifact={ignoreArtifactPreview}
                      onPreviewUploadAttachment={ignoreUploadPreview}
                      onOpenSkillMention={ignoreSkillOpen}
                      onPreviewMentionArtifact={ignoreMentionPreview}
                      onOpenSessionMention={ignoreMentionPreview}
                      artifacts={[]}
                      showUserActions={false}
                      contentPaddingClassName="px-0 md:px-0"
                    />
                  )
                }

                // Artifact provenance builds its immutable transcript from persisted messages and
                // activities only, so no live coordinator lifecycle rows are supplied here.
                if (conversationItem.type === 'handoff') return null

                if (conversationItem.type === 'plan-activity') {
                  return (
                    <WorkspacePlanActivityRecord
                      key={conversationItem.id}
                      activity={conversationItem.activity}
                      contentPaddingClassName="px-0 md:px-0"
                    />
                  )
                }

                // Config-change dividers are a live-transcript affordance; the immutable
                // provenance snapshot renders the raw messages without them.
                if (conversationItem.type === 'config-change') return null

                return (
                  <WorkspaceActivityGroup
                    key={conversationItem.id}
                    group={conversationItem}
                    isExpanded={!collapsedGroups.has(conversationItem.id)}
                    onToggleGroup={(groupId) =>
                      setCollapsedGroups((current) => {
                        const next = new Set(current)
                        if (next.has(groupId)) next.delete(groupId)
                        else next.add(groupId)
                        return next
                      })
                    }
                    expansionOverrides={expandedRows}
                    contentPaddingClassName="px-0 md:px-0"
                    onToggleRow={(activityId, nextExpanded) =>
                      setExpandedRows((current) => ({ ...current, [activityId]: nextExpanded }))
                    }
                  />
                )
              })}
            </div>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="z-10 border-border-200 bg-bg-000 shadow-card hover:bg-bg-200 data-[direction=end]:bottom-3" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

const ArtifactProvenancePanel = ({
  item,
  projectId,
  onClose,
  onVersionChange
}: ArtifactProvenancePanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const lineageKey = `${projectId}:${item.sessionId}:${item.artifactId ?? ''}`
  const lineageRequestKey = `${lineageKey}:${item.selectedVersionId ?? ''}`
  const [lineageResult, setLineageResult] = useState<{
    key: string
    value?: ArtifactLineageProvenance
    unavailable?: boolean
    error?: string
  }>()
  const [selectedVersion, setSelectedVersion] = useState<{
    artifactId: string
    versionId: string
  }>()
  const [provenanceResult, setProvenanceResult] = useState<{
    key: string
    value?: ArtifactVersionProvenance
    error?: string
  }>()
  const [activeTab, setActiveTab] = useState<ProvenanceTab>('code')
  // Keyed by the reading's digest: the same reading can be listed under more than one version, and a
  // re-issue is about that reading, not about where it happens to be displayed.
  const [readingVerdicts, setReadingVerdicts] = useState<
    Record<string, ReadingVerification | 'pending'>
  >({})

  // Re-issue a recorded reading and show what came back. The request names a session and a digest — the
  // URL never leaves the main process, which looks the reading up in its own record. Every outcome is
  // shown as itself: a pass, a difference with both digests, or a refusal that names its reason.
  const verifyReading = async (digest: string): Promise<void> => {
    setReadingVerdicts((current) => ({ ...current, [digest]: 'pending' }))
    try {
      const verdict = await window.api.artifacts.verifyReading({
        appSessionId: item.sessionId,
        digest
      })
      setReadingVerdicts((current) => ({ ...current, [digest]: verdict }))
    } catch {
      // The channel failed, which is not an answer from the source: report the re-issue as untaken
      // rather than leaving the row looking like a check nobody ran.
      setReadingVerdicts((current) => ({
        ...current,
        [digest]: { state: 'unavailable', reason: 'request-failed' }
      }))
    }
  }
  const [deferredSectionResults, setDeferredSectionResults] = useState<
    Record<string, DeferredSectionResult>
  >({})
  const [codeReconstructionResults, setCodeReconstructionResults] = useState<
    Record<string, CodeReconstructionPanelState>
  >({})
  const [reviewRevision, setReviewRevision] = useState(0)
  const [showAllPackagesKey, setShowAllPackagesKey] = useState<string>()
  const [exportingNotebook, setExportingNotebook] = useState(false)
  const [notebookExportFailure, setNotebookExportFailure] = useState<{
    key: string
    message: string
  }>()
  const [codeActionFailure, setCodeActionFailure] = useState<{
    key: string
    message: string
  }>()
  const lineage = lineageResult?.key === lineageRequestKey ? lineageResult.value : undefined
  const lineageUnavailable =
    lineageResult?.key === lineageRequestKey && lineageResult.unavailable === true
  const requestedVersionId =
    selectedVersion && selectedVersion.artifactId === item.artifactId
      ? selectedVersion.versionId
      : item.selectedVersionId
  const selectedVersionDescriptor = lineage
    ? resolveArtifactVersionDescriptor(lineage, requestedVersionId)
    : undefined
  const selectedVersionId = lineage ? selectedVersionDescriptor?.versionId : requestedVersionId
  const selectedVersionUnavailable = Boolean(lineage && requestedVersionId && !selectedVersionId)
  const provenanceKey = `${lineageKey}:${selectedVersionId ?? ''}`
  const coreProvenance =
    provenanceResult?.key === provenanceKey ? provenanceResult.value : undefined
  const showAllPackages = showAllPackagesKey === provenanceKey
  const notebookExportError =
    notebookExportFailure?.key === provenanceKey ? notebookExportFailure.message : undefined
  const codeActionError =
    codeActionFailure?.key === provenanceKey ? codeActionFailure.message : undefined
  const codeReconstructionResult = codeReconstructionResults[provenanceKey]
  const error =
    (selectedVersionUnavailable ? t('ws.selectedArtifactVersionUnavailable') : undefined) ??
    (lineageResult?.key === lineageRequestKey ? lineageResult.error : undefined) ??
    (provenanceResult?.key === provenanceKey ? provenanceResult.error : undefined)

  useEffect(() => {
    return window.api.reviewer.onUpdated((event: ReviewUpdateEvent) => {
      if (event.review.projectId === projectId && event.review.sessionId === item.sessionId) {
        setReviewRevision((revision) => revision + 1)
      }
    })
  }, [item.sessionId, projectId])

  useEffect(() => {
    let active = true
    if (!item.artifactId) return
    void window.api.artifacts
      .getLineage({ projectId, appSessionId: item.sessionId, artifactId: item.artifactId })
      .then((value) => {
        if (!active) return
        setLineageResult({ key: lineageRequestKey, value, unavailable: value === undefined })
      })
      .catch((failure: unknown) => {
        if (active) {
          setLineageResult({
            key: lineageRequestKey,
            error: failure instanceof Error ? failure.message : String(failure)
          })
        }
      })
    return () => {
      active = false
    }
  }, [item.artifactId, item.sessionId, lineageRequestKey, projectId])

  useEffect(() => {
    let active = true
    if (!item.artifactId || !selectedVersionId || !lineage) return
    void window.api.artifacts
      .getVersionProvenance({
        projectId,
        appSessionId: item.sessionId,
        artifactId: item.artifactId,
        versionId: selectedVersionId
      })
      .then((value) => {
        if (active) setProvenanceResult({ key: provenanceKey, value })
      })
      .catch((failure: unknown) => {
        if (active) {
          setProvenanceResult({
            key: provenanceKey,
            error: failure instanceof Error ? failure.message : String(failure)
          })
        }
      })
    return () => {
      active = false
    }
  }, [item.artifactId, item.sessionId, lineage, projectId, provenanceKey, selectedVersionId])

  useEffect(() => {
    if (
      activeTab !== 'code' ||
      !item.artifactId ||
      !selectedVersionId ||
      !coreProvenance ||
      codeReconstructionResult
    ) {
      return
    }
    const request = {
      projectId,
      appSessionId: item.sessionId,
      artifactId: item.artifactId,
      versionId: selectedVersionId
    }
    setCodeReconstructionResults((current) => ({
      ...current,
      [provenanceKey]: { status: 'loading' }
    }))
    void window.api.artifacts
      .getCodeReconstruction(request)
      .then((value) => {
        setCodeReconstructionResults((current) => ({
          ...current,
          [provenanceKey]: { status: 'loaded', value }
        }))
      })
      .catch((failure: unknown) => {
        setCodeReconstructionResults((current) => ({
          ...current,
          [provenanceKey]: {
            status: 'error',
            message: failure instanceof Error ? failure.message : String(failure)
          }
        }))
      })
  }, [
    activeTab,
    codeReconstructionResult,
    coreProvenance,
    item.artifactId,
    item.sessionId,
    projectId,
    provenanceKey,
    selectedVersionId
  ])

  const reviewReloadKey = activeTab === 'review' ? reviewRevision : 0
  const deferredTab = (
    activeTab === 'execution' || activeTab === 'messages' || activeTab === 'review'
      ? activeTab
      : undefined
  ) as DeferredProvenanceTab | undefined
  const deferredSectionKey = deferredTab
    ? `${provenanceKey}:${deferredTab}:${deferredTab === 'review' ? reviewReloadKey : 0}`
    : undefined
  const deferredSectionResult = deferredSectionKey
    ? deferredSectionResults[deferredSectionKey]
    : undefined
  const deferredSectionState = deferredSectionResult?.state
  const provenance = useMemo(
    () =>
      coreProvenance && deferredSectionResult?.state === 'loaded'
        ? { ...coreProvenance, ...deferredSectionResult.section }
        : coreProvenance,
    [coreProvenance, deferredSectionResult]
  )
  const deferredTabLabel = deferredTab
    ? t(tabs.find((tab) => tab.id === deferredTab)!.label)
    : undefined
  const deferredSectionLoading = Boolean(deferredSectionKey && deferredSectionState === undefined)
  const deferredSectionReady = !deferredSectionKey || deferredSectionState === 'loaded'
  const hasLoadedProvenance = Boolean(coreProvenance)
  useEffect(() => {
    let active = true
    if (!item.artifactId || !selectedVersionId || !hasLoadedProvenance) {
      return
    }
    const request = {
      projectId,
      appSessionId: item.sessionId,
      artifactId: item.artifactId,
      versionId: selectedVersionId
    }
    if (deferredSectionState !== undefined) return
    const load =
      activeTab === 'execution'
        ? window.api.artifacts.getVersionExecution(request)
        : activeTab === 'messages'
          ? window.api.artifacts.getVersionMessages(request)
          : activeTab === 'review'
            ? window.api.artifacts.getVersionReview(request)
            : undefined
    if (!load) return
    const sectionKey = `${provenanceKey}:${activeTab}:${activeTab === 'review' ? reviewReloadKey : 0}`
    void load
      .then((section) => {
        if (!active) return
        setDeferredSectionResults((current) => ({
          ...current,
          [sectionKey]: { state: 'loaded', section }
        }))
      })
      .catch((failure: unknown) => {
        if (!active) return
        setDeferredSectionResults((current) => ({
          ...current,
          [sectionKey]: {
            state: 'error',
            message: failure instanceof Error ? failure.message : String(failure)
          }
        }))
      })
    return () => {
      active = false
    }
  }, [
    activeTab,
    deferredSectionState,
    item.artifactId,
    item.sessionId,
    hasLoadedProvenance,
    projectId,
    provenanceKey,
    reviewReloadKey,
    selectedVersionId
  ])

  const selectedIndex =
    lineage?.versions.findIndex((version) => version.versionId === selectedVersionId) ?? -1
  const evidence = provenance?.evidence
  const producer = asRecord(evidence?.producer)
  const environment = asRecord(evidence?.environment)
  const environmentPackages = Array.isArray(environment?.packages)
    ? environment.packages
        .map(asRecord)
        .filter((pkg): pkg is Record<string, unknown> => pkg !== undefined)
    : []
  const environmentOperations = Array.isArray(environment?.op_log)
    ? environment.op_log
        .map(asRecord)
        .filter((operation): operation is Record<string, unknown> => operation !== undefined)
    : []
  const operationLogTruncation = asRecord(environment?.op_log_truncation)
  const omittedOperationCount =
    typeof operationLogTruncation?.omitted_count === 'number'
      ? operationLogTruncation.omitted_count
      : 0
  const earliestRetainedOperationAt = asString(operationLogTruncation?.earliest_retained_at)
  const environmentWarnings = Array.isArray(environment?.warnings)
    ? environment.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  const requestedPackageKeys = new Set(
    environmentOperations.flatMap((operation) =>
      Array.isArray(operation.packages)
        ? operation.packages.flatMap((entry) => {
            const name = typeof entry === 'string' ? packageNameFromSpec(entry) : undefined
            return name ? [packageKey(name)] : []
          })
        : []
    )
  )
  const isPythonEnvironment = asString(environment?.kernel_kind) === 'python'
  const relevantEnvironmentPackages = isPythonEnvironment
    ? environmentPackages.filter((pkg) => {
        const state = asString(pkg.loaded_state)
        const name = asString(pkg.name)
        return (
          state === 'loaded' ||
          state === 'attached' ||
          (name !== undefined && requestedPackageKeys.has(packageKey(name)))
        )
      })
    : environmentPackages
  const filteredEnvironmentPackages =
    relevantEnvironmentPackages.length > 0 ? relevantEnvironmentPackages : environmentPackages
  const visibleEnvironmentPackages = showAllPackages
    ? environmentPackages
    : filteredEnvironmentPackages
  const hasFilteredEnvironmentPackages =
    filteredEnvironmentPackages.length < environmentPackages.length
  const rawExecutionRuns = Array.isArray(provenance?.execution?.runs)
    ? provenance.execution.runs
    : []
  const executionRuns = useMemo(
    () => (provenance?.execution?.runs ?? []).map(toNotebookRun),
    [provenance]
  )
  const executionTruncation = provenance?.execution?.truncation
  const reviewProjection =
    provenance?.review.state === 'available' ? provenance.review.value : undefined
  const reviewUnavailableReason =
    provenance?.review.state === 'unavailable' ? provenance.review.reason : undefined
  const reviewAssessment = reviewProjection
    ? (reviewProjection.currentDirectAssessment ?? reviewProjection.latestChainReview)
    : undefined
  const reviewForCard =
    reviewAssessment && reviewProjection
      ? {
          ...reviewAssessment,
          checks: [...reviewProjection.selectedVersionChecks, ...reviewProjection.turnLevelChecks]
        }
      : undefined
  const executionKernels = [
    ...new Set(
      rawExecutionRuns
        .map((run) => asString(asRecord(run)?.kernelKind))
        .filter((kernel): kernel is 'python' | 'r' => kernel === 'python' || kernel === 'r')
    )
  ]
  const reproductionCode = provenance?.evidence.reproduction_code
  const producerInputs: NotebookInputFileSummary[] = (provenance?.evidence.inputs ?? []).map(
    (input) => ({
      inputFileVersionId: input.input_file_version_id,
      sourceKind: input.source_kind,
      sourceFileId: input.source_file_id,
      sourceVersionNumber: input.source_version_number,
      sourceCreatedAt: input.source_created_at,
      sourceProjectId: input.source_project_id,
      sourceSessionId: input.source_session_id,
      filename: input.filename,
      contentType: input.content_type,
      sizeBytes: input.size_bytes,
      checksum: input.checksum,
      association: input.strongest_association
    })
  )

  const openReviewTranscript = (intent: GoToTranscriptIntent): void => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createSessionReviewerPreviewItem({
        sessionId: item.sessionId,
        reviewId: intent.reviewId,
        findingId: intent.findingId,
        locator: intent.locator
      })
    )
  }

  const selectVersion = (versionId: string): void => {
    if (!item.artifactId) return
    const version = lineage?.versions.find((candidate) => candidate.versionId === versionId)
    if (!version) return

    setSelectedVersion({ artifactId: item.artifactId, versionId })
    const nextItem = createPreviewFileItemForArtifactVersion({ item, version, projectId })
    if (onVersionChange) onVersionChange(nextItem)
    else usePreviewWorkbenchStore.getState().upsertItem(nextItem)
  }

  const downloadExecutionNotebook = async (): Promise<void> => {
    if (executionKernels.length === 0 || !item.artifactId || !selectedVersionId) return
    setExportingNotebook(true)
    setNotebookExportFailure(undefined)
    try {
      const baseName = item.name.replace(/\.[^.]+$/u, '') || 'artifact'
      const versionNumber = lineage?.versions[selectedIndex]?.versionNumber ?? 1
      for (const kernel of executionKernels) {
        const notebook = buildExecutionNotebook(rawExecutionRuns, kernel, {
          artifactId: item.artifactId,
          versionId: selectedVersionId,
          producerRunId: asString(producer?.producer_run_id),
          runtimeVersion:
            asString(environment?.kernel_kind) === kernel
              ? asString(environment?.runtime_version)
              : undefined
        })
        const bytes = new TextEncoder().encode(`${JSON.stringify(notebook, null, 2)}\n`)
        const data = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer
        const kernelSuffix = executionKernels.length > 1 ? `-${kernel}` : ''
        await window.api.saveBlobFile({
          suggestedName: `${baseName}-v${versionNumber}${kernelSuffix}.ipynb`,
          mimeType: 'application/x-ipynb+json',
          data
        })
      }
    } catch (failure) {
      setNotebookExportFailure({
        key: provenanceKey,
        message: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setExportingNotebook(false)
    }
  }

  const downloadScript = async (
    code: string,
    language: ArtifactCodeReconstruction['language']
  ): Promise<void> => {
    try {
      const bytes = new TextEncoder().encode(code)
      const data = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer
      const baseName = item.name.replace(/\.[^.]+$/u, '') || 'artifact'
      const versionNumber = lineage?.versions[selectedIndex]?.versionNumber ?? 1
      const format = scriptDownloadFormats[language]
      await window.api.saveBlobFile({
        suggestedName: `${baseName}-v${versionNumber}.${format.extension}`,
        mimeType: format.mimeType,
        data
      })
      setCodeActionFailure(undefined)
    } catch (failure) {
      setCodeActionFailure({
        key: provenanceKey,
        message: failure instanceof Error ? failure.message : String(failure)
      })
    }
  }

  const downloadProducerCode = async (): Promise<void> => {
    if (!reproductionCode) return
    const evidenceProducer = provenance?.evidence.producer
    const language = evidenceProducer?.state === 'available' ? evidenceProducer.kernel_kind : 'repl'
    await downloadScript(reproductionCode, language)
  }

  const generateCodeReconstruction = async (): Promise<void> => {
    if (!item.artifactId || !selectedVersionId) return
    const previous =
      codeReconstructionResult?.status === 'loaded'
        ? codeReconstructionResult.value
        : codeReconstructionResult?.status === 'error'
          ? codeReconstructionResult.previous
          : undefined
    if (!previous || previous.state !== 'ready') return
    setCodeReconstructionResults((current) => ({
      ...current,
      [provenanceKey]: { status: 'generating', previous }
    }))
    try {
      const value = await window.api.artifacts.generateCodeReconstruction({
        projectId,
        appSessionId: item.sessionId,
        artifactId: item.artifactId,
        versionId: selectedVersionId
      })
      setCodeReconstructionResults((current) => ({
        ...current,
        [provenanceKey]: { status: 'loaded', value }
      }))
    } catch (failure) {
      setCodeReconstructionResults((current) => ({
        ...current,
        [provenanceKey]: {
          status: 'error',
          message: failure instanceof Error ? failure.message : String(failure),
          previous
        }
      }))
    }
  }

  const retryCodeReconstructionLookup = (): void => {
    setCodeReconstructionResults((current) => {
      const next = { ...current }
      delete next[provenanceKey]
      return next
    })
  }

  const codeReconstructionState =
    codeReconstructionResult?.status === 'loaded'
      ? codeReconstructionResult.value
      : codeReconstructionResult?.status === 'generating'
        ? codeReconstructionResult.previous
        : codeReconstructionResult?.status === 'error'
          ? codeReconstructionResult.previous
          : undefined
  const generatedCode =
    codeReconstructionState?.state === 'cached' ? codeReconstructionState.value : undefined

  return (
    <div className="flex size-full min-h-0 flex-col bg-bg-000" data-testid="artifact-provenance">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-300/60 px-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('ws.previousArtifactVersion')}
          disabled={selectedIndex <= 0}
          onClick={() => {
            const versionId = lineage?.versions[selectedIndex - 1]?.versionId
            if (versionId) selectVersion(versionId)
          }}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="text-xs font-medium text-text-100">
          {selectedIndex >= 0 ? `v${lineage?.versions[selectedIndex]?.versionNumber}` : 'Version'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('ws.nextArtifactVersion')}
          disabled={!lineage || selectedIndex < 0 || selectedIndex >= lineage.versions.length - 1}
          onClick={() => {
            const versionId = lineage?.versions[selectedIndex + 1]?.versionId
            if (versionId) selectVersion(versionId)
          }}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-text-300">
          {lineage?.originSession.state === 'deleted'
            ? [
                t('ws.sourceSessionDeleted'),
                lineage.originSession.title,
                lineage.originSession.deletedAt
                  ? new Date(lineage.originSession.deletedAt).toLocaleString()
                  : undefined
              ]
                .filter(Boolean)
                .join(' · ')
            : lineage?.originSession.title}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('ws.closeProvenance')}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div
        role="tablist"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-300/60 px-2 py-1"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`rounded px-2 py-1 text-xs ${activeTab === tab.id ? 'bg-bg-300 text-text-000' : 'text-text-300 hover:text-text-100'}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {t(tab.label)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <p className="p-5 text-sm text-danger-000">{error}</p> : null}
        {!error && lineageUnavailable ? (
          <p className="p-5 text-sm text-text-300">{t('settings.provenanceUnavailableLegacy')}</p>
        ) : null}
        {!error && !lineageUnavailable && !provenance ? (
          <div className="flex h-full items-center justify-center text-text-300">
            <LoaderCircle
              className="size-4 animate-spin"
              aria-label={t('artifact.loadingProvenance')}
            />
          </div>
        ) : null}
        {provenance && deferredTabLabel && deferredSectionLoading ? (
          <div
            className="flex h-full items-center justify-center gap-2 text-sm text-text-300"
            aria-label={`Loading ${deferredTabLabel}`}
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Loading {deferredTabLabel}
          </div>
        ) : null}
        {provenance && deferredSectionResult?.state === 'error' ? (
          <p className="p-5 text-sm text-danger-000">{deferredSectionResult.message}</p>
        ) : null}
        {provenance && activeTab === 'code' ? (
          <section>
            {provenance.contentStatus.state === 'unavailable' ? (
              <p className="border-b border-warning-100/50 bg-warning-100/10 px-4 py-2 text-xs text-warning-900">
                Artifact content is {provenance.contentStatus.reason}; captured provenance remains
                available.
              </p>
            ) : null}
            <div className={tabActionBarClassName}>
              {generatedCode ? (
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => void downloadScript(generatedCode.code, generatedCode.language)}
                >
                  <Download aria-hidden="true" />
                  {t('artifact.downloadScript')}
                </Button>
              ) : codeReconstructionResult?.status === 'generating' ? (
                <Button type="button" size="sm" className="shrink-0 whitespace-nowrap" disabled>
                  <LoaderCircle
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  Generating…
                </Button>
              ) : codeReconstructionState?.state === 'ready' ? (
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => void generateCodeReconstruction()}
                >
                  {t('artifact.generateScript')}
                </Button>
              ) : codeReconstructionResult?.status === 'error' ? (
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() =>
                    codeReconstructionResult.previous?.state === 'ready'
                      ? void generateCodeReconstruction()
                      : retryCodeReconstructionLookup()
                  }
                >
                  Retry
                </Button>
              ) : codeReconstructionState?.state === 'unavailable' ? (
                <Button type="button" size="sm" className="shrink-0 whitespace-nowrap" disabled>
                  {t('artifact.generateScript')}
                </Button>
              ) : (
                <LoaderCircle
                  className="size-4 animate-spin text-text-300 motion-reduce:animate-none"
                  aria-label={t('ws.checkingForGeneratedScript')}
                />
              )}
              {generatedCode ? (
                <div className="min-w-0 flex-1 truncate text-sm text-text-300">
                  <span>{t('artifact.reconstructionPrefix')}</span>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto whitespace-nowrap px-0 py-0 text-sm"
                    onClick={() => setActiveTab('execution')}
                  >
                    Execution Log
                  </Button>
                  <span>{t('artifact.reconstructionSuffix')}</span>
                </div>
              ) : codeReconstructionResult?.status === 'error' ? (
                <p className="min-w-0 flex-1 truncate text-sm text-danger-000" role="alert">
                  {codeReconstructionResult.message}
                </p>
              ) : codeReconstructionState?.state === 'unavailable' ? (
                <p className="min-w-0 flex-1 truncate text-sm text-text-300">
                  {codeReconstructionUnavailableLabel(codeReconstructionState.reason, t)}
                </p>
              ) : codeReconstructionResult?.status === 'generating' ? (
                <p className="min-w-0 flex-1 truncate text-sm text-text-300">
                  {t('artifact.generateScriptHint')}
                </p>
              ) : codeReconstructionState?.state === 'ready' ? (
                <p className="min-w-0 flex-1 truncate text-sm text-text-300">
                  Generate a standalone script from the immutable Execution Log with your current
                  provider and model.
                </p>
              ) : (
                <p className="min-w-0 flex-1 truncate text-sm text-text-300">
                  {t('artifact.checkingPreviousScript')}
                </p>
              )}
            </div>
            {producerInputs.length > 0 ? (
              <NotebookInputDataStrip
                inputFiles={producerInputs}
                label={t('settings.inputs')}
                className="border-b border-border-300/50 px-4 py-2"
              />
            ) : null}
            {generatedCode?.sourceTruncated ||
            (codeReconstructionState?.state === 'ready' &&
              codeReconstructionState.sourceTruncated) ? (
              <p className="border-b border-warning-100/50 bg-warning-100/10 px-4 py-2 text-xs text-text-200">
                {t('artifact.reconstructionBounded')}
              </p>
            ) : null}
            {codeReconstructionResult?.status === 'generating' ? (
              <div
                className="flex min-h-48 items-center justify-center gap-2 px-4 py-8 text-sm text-text-300"
                role="status"
                aria-live="polite"
                aria-label={t('ws.generatingReconstructedScript')}
              >
                <LoaderCircle
                  className="size-5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <span>{t('artifact.generatingScript')}</span>
              </div>
            ) : generatedCode ? (
              <NotebookCodeBlock code={generatedCode.code} language={generatedCode.language} />
            ) : (
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-text-000">
                    {t('artifact.capturedProducerBlock')}
                  </h3>
                  {reproductionCode ? (
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void downloadProducerCode()}
                      >
                        <Download aria-hidden="true" />
                        Download
                      </Button>
                    </div>
                  ) : null}
                </div>
                {reproductionCode ? (
                  <NotebookCodeBlock
                    code={reproductionCode}
                    language={
                      provenance.evidence.producer.state === 'available'
                        ? provenance.evidence.producer.kernel_kind
                        : undefined
                    }
                  />
                ) : (
                  <p className="text-sm text-text-300">
                    No producer block was recorded for this version. {statusReason(producer)}
                  </p>
                )}
              </div>
            )}
            {codeActionError ? (
              <p className="px-4 py-2 text-xs text-danger-000" role="alert">
                {codeActionError}
              </p>
            ) : null}
          </section>
        ) : null}
        {provenance && activeTab === 'execution' && deferredSectionReady ? (
          executionRuns.length > 0 ? (
            <div>
              {executionTruncation ? (
                <p className="border-b border-warning-100/50 bg-warning-100/10 px-4 py-2 text-xs text-text-200">
                  Execution evidence was bounded for storage: omitted{' '}
                  {executionTruncation.omittedLeadingRunCount} earlier runs,{' '}
                  {executionTruncation.omittedOutputCount} outputs, and{' '}
                  {executionTruncation.omittedInputCount} inputs.
                </p>
              ) : null}
              <div className={tabActionBarClassName}>
                <Button
                  type="button"
                  size="sm"
                  disabled={executionKernels.length === 0 || exportingNotebook}
                  onClick={() => void downloadExecutionNotebook()}
                >
                  {exportingNotebook ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Download aria-hidden="true" />
                  )}
                  {exportingNotebook
                    ? t('common.preparing')
                    : executionKernels.length > 1
                      ? t('ws.downloadNotebooks')
                      : t('ws.downloadNotebook')}
                </Button>
              </div>
              {notebookExportError ? (
                <p className="px-4 py-2 text-xs text-danger-000">{notebookExportError}</p>
              ) : null}
              <div className="divide-y divide-border-300/50">
                {executionRuns.map(({ run, index, scriptTruncated }) => (
                  <NotebookDialogCell
                    key={run.runId}
                    run={run}
                    index={index}
                    scriptTruncated={scriptTruncated}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="p-5">
              <p className="text-sm text-text-300">{t('artifact.noProducerExecution')}</p>
              <p className="mt-1 text-xs text-text-300">{t('artifact.noProducerExecutionHint')}</p>
            </div>
          )
        ) : null}
        {provenance && activeTab === 'messages' && deferredSectionReady ? (
          provenance.messages.state === 'available' ? (
            <ProvenanceMessagesTimeline
              key={provenanceKey}
              snapshot={provenance.messages}
              projectId={projectId}
              sessionId={item.sessionId}
            />
          ) : (
            <p className="p-5 text-sm text-text-300">
              The immutable message snapshot is not available for this version (
              {provenance.messages.reason}).
            </p>
          )
        ) : null}
        {provenance &&
        activeTab === 'replay' &&
        selectedVersionId &&
        item.artifactId &&
        item.sessionId ? (
          <ArtifactReplaySection
            projectId={projectId}
            appSessionId={item.sessionId}
            artifactId={item.artifactId}
            versionId={selectedVersionId}
          />
        ) : null}

        {provenance && activeTab === 'environment' ? (
          <section className="space-y-4 p-5 text-sm">
            <h3 className="font-semibold text-text-000">
              {asString(environment?.environment_name) ??
                provenance.descriptor.environment ??
                t('ws.environmentUnavailable')}
            </h3>
            {environment ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-text-300">{t('settings.runtime')}</dt>
                  <dd className="text-text-100">
                    {asString(environment.runtime_version) ?? t('ws.versionUnavailable')}
                  </dd>
                  <dt className="text-text-300">{t('artifact.provenanceSourceLabel')}</dt>
                  <dd className="text-text-100">
                    {asString(environment.runtime_source) ?? 'unknown'} ·{' '}
                    {asString(environment.kernel_kind) ?? 'unknown'}
                  </dd>
                  <dt className="text-text-300">{t('artifact.capture')}</dt>
                  <dd className="text-text-100">
                    {asString(environment.capture_status) ?? 'partial'} ·{' '}
                    {environmentPackages.length} packages
                  </dd>
                </dl>
                {environmentWarnings.length > 0 ? (
                  <div
                    role="status"
                    className="rounded-md border border-warning-100/50 bg-warning-100/10 px-3 py-2 text-xs text-text-200"
                  >
                    <p className="font-medium text-text-100">
                      {t('artifact.partialCaptureDetails')}
                    </p>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {environmentWarnings.map((warning) => (
                        <li key={warning}>{environmentWarningLabel(warning, t)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="overflow-hidden rounded-md border border-border-300/60">
                  <table className="w-full table-fixed text-left text-xs">
                    <thead className="bg-bg-100 text-text-300">
                      <tr>
                        <th className="w-1/2 px-3 py-2 font-medium">{t('artifact.package')}</th>
                        <th className="w-1/4 px-3 py-2 font-medium">{t('settings.version')}</th>
                        <th className="w-1/4 px-3 py-2 font-medium">{t('artifact.state')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEnvironmentPackages.map((pkg) => (
                        <tr
                          key={`${asString(pkg.name)}:${asString(pkg.version)}`}
                          className="border-t border-border-300/40"
                        >
                          <td className="truncate px-3 py-2 text-text-100">
                            {asString(pkg.name) ?? t('ws.unknownPackage')}
                          </td>
                          <td className="px-3 py-2 text-text-300">
                            {asString(pkg.version) ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-text-300">
                            {asString(pkg.loaded_state) ?? 'unknown'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {hasFilteredEnvironmentPackages ? (
                  <button
                    type="button"
                    className="text-xs font-medium text-accent-000 hover:underline"
                    onClick={() =>
                      setShowAllPackagesKey((key) =>
                        key === provenanceKey ? undefined : provenanceKey
                      )
                    }
                  >
                    {showAllPackages
                      ? `Show relevant ${filteredEnvironmentPackages.length} packages`
                      : `Show all ${environmentPackages.length} packages`}
                  </button>
                ) : null}
                {omittedOperationCount > 0 ? (
                  <p className="rounded-md bg-bg-100 px-3 py-2 text-xs text-text-300">
                    {`${omittedOperationCount} earlier operation${omittedOperationCount === 1 ? '' : 's'} omitted from this bounded history.`}
                    {earliestRetainedOperationAt
                      ? ` Retained entries begin ${new Date(earliestRetainedOperationAt).toLocaleString()}.`
                      : ''}
                  </p>
                ) : null}
                {environmentOperations.length > 0 ? (
                  <div className="space-y-2">
                    <h4 className="font-semibold text-text-000">{t('artifact.operations')}</h4>
                    <div className="overflow-hidden rounded-md border border-border-300/60">
                      <table className="w-full table-fixed text-left text-xs">
                        <thead className="bg-bg-100 text-text-300">
                          <tr>
                            <th className="w-[34%] break-words px-2 py-2 font-medium">
                              {t('settings.perRunColumnTime')}
                            </th>
                            <th className="w-1/5 break-words px-2 py-2 font-medium">
                              {t('artifact.operation')}
                            </th>
                            <th className="w-[28%] break-words px-2 py-2 font-medium">
                              {t('artifact.packages')}
                            </th>
                            <th className="w-[18%] break-words px-2 py-2 font-medium">
                              {t('artifact.result')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {environmentOperations.map((operation, index) => {
                            const timestamp = asString(operation.timestamp)
                            const rawPackageChanges = operation.package_changes
                            const hasPackageChanges = Array.isArray(rawPackageChanges)
                            const packageChanges = hasPackageChanges
                              ? rawPackageChanges
                                  .map(asRecord)
                                  .filter(
                                    (change): change is Record<string, unknown> =>
                                      change !== undefined
                                  )
                              : []
                            const requestedChanges = packageChanges.filter(
                              (change) => asString(change.relationship) === 'requested'
                            )
                            const dependencyChanges = packageChanges.filter(
                              (change) => asString(change.relationship) === 'dependency'
                            )
                            const unattributedChanges = packageChanges.filter(
                              (change) => asString(change.relationship) === 'unattributed'
                            )
                            const key = asString(operation.operation_id) ?? `operation-${index}`
                            return (
                              <Fragment key={key}>
                                <tr className="border-t border-border-300/40">
                                  <td className="align-top px-2 py-2 text-text-300">
                                    {timestamp ? (
                                      <time
                                        dateTime={timestamp}
                                        className="block whitespace-normal break-words tabular-nums leading-5"
                                      >
                                        {new Date(timestamp).toLocaleString()}
                                      </time>
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                  <td className="whitespace-normal break-words px-2 py-2 align-top text-text-100">
                                    {asString(operation.operation) ?? 'unknown'}
                                  </td>
                                  <td className="whitespace-normal break-words px-2 py-2 align-top text-text-300">
                                    {requestedChanges.length > 0
                                      ? requestedChanges.map(packageChangeLabel).join(', ')
                                      : Array.isArray(operation.packages)
                                        ? operation.packages
                                            .filter(
                                              (entry): entry is string => typeof entry === 'string'
                                            )
                                            .join(', ')
                                        : '—'}
                                  </td>
                                  <td className="whitespace-normal break-words px-2 py-2 align-top text-text-300">
                                    {asString(operation.result) ?? 'unknown'}
                                  </td>
                                </tr>
                                {hasPackageChanges ? (
                                  <tr className="border-t border-border-300/30 bg-bg-100/60">
                                    <td colSpan={4} className="px-2 py-2 text-text-300">
                                      {dependencyChanges.length > 0 ? (
                                        <div>
                                          <span className="font-medium text-text-200">
                                            {t('artifact.dependencyImpact')}
                                          </span>
                                          <div className="mt-1 flex flex-wrap gap-1.5">
                                            {dependencyChanges.map((change, changeIndex) => (
                                              <span
                                                key={`${key}-dependency-${changeIndex}`}
                                                className="rounded bg-bg-200 px-1.5 py-0.5 font-mono text-[11px] text-text-200"
                                              >
                                                {packageChangeLabel(change)}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}
                                      {unattributedChanges.length > 0 ? (
                                        <div className={dependencyChanges.length > 0 ? 'mt-2' : ''}>
                                          <span className="font-medium text-text-200">
                                            Observed since the previous snapshot (not attributed to
                                            this operation)
                                          </span>
                                          <div className="mt-1 flex flex-wrap gap-1.5">
                                            {unattributedChanges.map((change, changeIndex) => (
                                              <span
                                                key={`${key}-unattributed-${changeIndex}`}
                                                className="rounded bg-bg-200 px-1.5 py-0.5 font-mono text-[11px] text-text-200"
                                              >
                                                {packageChangeLabel(change)}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}
                                      {dependencyChanges.length === 0 &&
                                      unattributedChanges.length === 0 ? (
                                        <span>{t('artifact.noDependencyChanges')}</span>
                                      ) : null}
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-text-300">
                {statusReason(evidence?.environment_status) ??
                  t('ws.environmentEvidenceNotCaptured')}
              </p>
            )}
          </section>
        ) : null}
        {provenance && activeTab === 'review' && deferredSectionReady ? (
          reviewForCard ? (
            <section className="p-4">
              <ReviewerCard
                review={reviewForCard}
                defaultExpanded
                onGoToTranscript={openReviewTranscript}
              />
              {lineage?.originSession.state === 'deleted' ? (
                <p className="mt-3 text-xs text-text-300">{t('artifact.capturedBeforeDeletion')}</p>
              ) : null}
            </section>
          ) : (
            <section className="flex gap-3 p-5">
              <Circle className="mt-0.5 size-4 text-text-300" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-semibold text-text-000">
                  {reviewUnavailableReason === 'source-session-unavailable'
                    ? t('ws.reviewUnavailable')
                    : t('ws.noReviewForVersion')}
                </h3>
                <p className="mt-1 text-sm text-text-300">
                  {reviewUnavailableReason === 'source-session-unavailable'
                    ? 'The active source session could not be loaded, so its saved review cannot be verified as current.'
                    : lineage?.originSession.state === 'deleted'
                      ? t('ws.sourceSessionDeletedBeforeReview')
                      : t('ws.versionGeneratedWithoutAudit')}
                </p>
                {reviewUnavailableReason !== 'source-session-unavailable' ? (
                  <p className="mt-3 text-xs text-text-300">{t('artifact.modelNotTriggered')}</p>
                ) : null}
              </div>
            </section>
          )
        ) : null}
        {provenance && activeTab === 'readings' ? (
          <section className="space-y-3 p-5 text-sm" data-testid="artifact-readings">
            {provenance.readings.state === 'available' ? (
              <>
                <p className="text-xs text-text-300">
                  {/* The window is only promised when it was enforced: with no parseable `created_at`
                      on the evidence the panel says so instead of claiming a window it never applied. */}
                  {provenance.readings.attribution === 'session-window'
                    ? t('ws.readingsIntro')
                    : t('ws.readingsSessionOnly')}
                </p>
                <p className="text-xs text-text-300" data-testid="artifact-readings-recipe">
                  {t('ws.readingsRecipe').replace('{recipe}', READING_FINGERPRINT_HASH_RECIPE)}
                </p>
                {provenance.readings.items.length === 0 ? (
                  <p className="text-text-300" data-testid="artifact-readings-empty">
                    {t('ws.readingsEmpty')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {provenance.readings.items.map((reading, index) => (
                      <li
                        key={`${reading.service}:${reading.tool}:${reading.response.sha256}:${index}`}
                        className="space-y-1 rounded-md border border-border-300/60 px-3 py-2"
                        data-testid="artifact-readings-item"
                      >
                        <p className="text-text-000">
                          {reading.service} · {reading.tool}
                        </p>
                        {/* Marked only when the run that took this reading is the run that produced
                            this Version — both ids are on screen, and neither is inferred. */}
                        {reading.runId &&
                        provenance.evidence.producer.state === 'available' &&
                        reading.runId === provenance.evidence.producer.producer_run_id ? (
                          <p
                            className="text-xs text-text-300"
                            data-testid="artifact-readings-same-run"
                          >
                            {t('ws.readingsSameRun')}
                          </p>
                        ) : null}
                        {/* The request URL is the engine's own redacted form; the fingerprint is computed
                            over exactly this string, so it must not be shortened here. */}
                        <p
                          className="truncate font-mono text-xs text-text-300"
                          title={`${reading.request.method} ${reading.request.url}`}
                        >
                          {reading.request.method} {reading.request.url}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid="artifact-readings-verify"
                            disabled={readingVerdicts[reading.response.sha256] === 'pending'}
                            onClick={() => void verifyReading(reading.response.sha256)}
                          >
                            {t('ws.readingsVerify')}
                          </Button>
                          {readingVerdicts[reading.response.sha256] === 'pending' ? (
                            <p
                              className="text-xs text-text-300"
                              data-testid="artifact-readings-verify-pending"
                            >
                              {t('ws.readingsVerifyPending')}
                            </p>
                          ) : null}
                          {readingVerdicts[reading.response.sha256] &&
                          readingVerdicts[reading.response.sha256] !== 'pending' ? (
                            <p
                              className="text-xs text-text-300"
                              data-testid="artifact-readings-verify-verdict"
                            >
                              {(() => {
                                const verdict = readingVerdicts[reading.response.sha256]
                                if (verdict === 'pending' || !verdict) return null
                                if (verdict.state === 'matched') {
                                  return t('ws.readingsVerifyMatched', {
                                    status: String(verdict.status)
                                  })
                                }
                                if (verdict.state === 'mismatch') {
                                  return t('ws.readingsVerifyMismatch', {
                                    status: String(verdict.status),
                                    recorded: `${verdict.recorded.slice(0, 18)}…`,
                                    recomputed: `${verdict.recomputed.slice(0, 18)}…`
                                  })
                                }
                                // The reason is a name the main process chose; it is shown verbatim
                                // rather than dressed up, so it stays greppable.
                                return `${t('ws.readingsVerifyRefused')} ${verdict.reason}`
                              })()}
                            </p>
                          ) : null}
                        </div>
                        <p className="font-mono text-xs text-text-300">
                          {reading.response.status} · {formatBytes(reading.response.bytes)} ·{' '}
                          {reading.response.sha256}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {provenance.readings.dropped > 0 ? (
                  <p className="text-xs text-text-300" data-testid="artifact-readings-dropped">
                    {t('ws.readingsDropped').replace(
                      '{count}',
                      String(provenance.readings.dropped)
                    )}
                  </p>
                ) : null}
                {provenance.readings.afterWindow > 0 ? (
                  // Readings taken after this Version was written are not listed above; saying how many
                  // keeps the window from reading as "these were everything the session read".
                  <p className="text-xs text-text-300" data-testid="artifact-readings-after-window">
                    {t('ws.readingsAfterWindow').replace(
                      '{count}',
                      String(provenance.readings.afterWindow)
                    )}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-text-300" data-testid="artifact-readings-gap">
                {provenance.readings.reason === 'not-recorded'
                  ? t('ws.readingsNotRecorded')
                  : provenance.readings.reason === 'unreadable'
                    ? t('ws.readingsUnreadable')
                    : t('ws.readingsNotLoaded')}
              </p>
            )}
          </section>
        ) : null}
      </div>
    </div>
  )
}

export { ArtifactProvenancePanel, ProvenanceMessagesTimeline }
