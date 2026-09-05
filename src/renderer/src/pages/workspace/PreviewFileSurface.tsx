import { useLanguage } from '@/i18n'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  GitCompare,
  Maximize2,
  MoreHorizontal,
  Pencil,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PreviewFileFormat, PreviewFileItem } from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'
import type { ArtifactFile } from '../../../../shared/artifacts'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  ArtifactVersionFile
} from '../../../../shared/artifact-provenance'
import { createArtifactVersionLocator } from '../../../../shared/artifact-provenance'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { ArtifactCompareDialog } from './ArtifactCompareDialog'
import { ArtifactEditDialog } from './ArtifactEditDialog'
import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { LocalFileHeaderActions } from './LocalFileHeaderActions'
import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import {
  createPreviewFileItemForArtifactVersion,
  resolveArtifactVersionDescriptor
} from './preview-file-item'
import { formatVersionTimestamp } from './artifact-version-content'
import { PreviewFileContent } from './previews/PreviewFileContent'
import { ArtifactProvenancePanel } from './ArtifactProvenancePanel'

// User-editable preview formats: plain-text renderers whose content round-trips through the edit
// dialog. Binary/structured formats (images, PDFs, notebooks) never offer an Edit action.
const EDITABLE_PREVIEW_FORMATS = new Set<PreviewFileFormat>(['markdown', 'text', 'code', 'json'])

type PreviewFileSurfaceProps = {
  item: PreviewFileItem
  contentKey?: string
  renderContent?: boolean
  tooltipClassName?: string
  onClose: () => void
  onOpenFullScreen?: () => void
  onOpenProvenance?: () => void
  onReload?: () => void
  provenanceEntry?: 'menu' | 'leading' | 'trailing'
}

const PreviewProvenanceButton = ({
  item,
  onOpenProvenance,
  tooltipClassName
}: {
  item: PreviewFileItem
  onOpenProvenance: () => void
  tooltipClassName?: string
}): React.JSX.Element => (
  <TooltipProvider delayDuration={300}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-text-100 hover:text-text-000"
          aria-label={`Open Provenance for ${item.title}`}
          onClick={onOpenProvenance}
        >
          <GitBranch aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className={tooltipClassName}>Provenance</TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

// The optional callback makes the maximize action available only in the compact workbench panel;
// the dialog reuses this header without exposing a nested full-screen action.
const PreviewFileHeader = ({
  item,
  onClose,
  onOpenFullScreen,
  onOpenProvenance,
  onReload,
  provenanceEntry = 'menu',
  tooltipClassName
}: Pick<
  PreviewFileSurfaceProps,
  | 'item'
  | 'onClose'
  | 'onOpenFullScreen'
  | 'onOpenProvenance'
  | 'onReload'
  | 'provenanceEntry'
  | 'tooltipClassName'
>): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <header
      data-testid="preview-card-header"
      className={`flex shrink-0 items-center gap-1 border-b border-border-300/50 px-2 ${
        // The local header carries the file path on a second line, so it grows past one row.
        item.source === 'local' ? 'min-h-8 py-0.5' : 'h-8'
      }`}
    >
      {onOpenProvenance && provenanceEntry === 'leading' ? (
        <PreviewProvenanceButton
          item={item}
          onOpenProvenance={onOpenProvenance}
          tooltipClassName={tooltipClassName}
        />
      ) : null}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1 text-[12px] font-medium text-text-000">
              <ExtensionPreservingFileName name={item.name} className="flex-1" />
              {item.source === 'local' ? (
                <span
                  data-testid="local-file-path"
                  className="flex min-w-0 items-center gap-1 text-[10px] font-normal leading-tight text-text-100"
                >
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-px">
                    {t('previewSurface.thisComputer')}
                  </span>
                  <span className="truncate">{item.path}</span>
                </span>
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipContent className={tooltipClassName}>
            {item.source === 'local' ? item.path : item.title}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* A local file has no managed provenance or origin Session, so it takes the reload/copy/open
        actions in place of the whole managed action row. */}
      {item.source === 'local' ? (
        <LocalFileHeaderActions
          path={item.path}
          name={item.name}
          onReload={onReload}
          tooltipClassName={tooltipClassName}
        />
      ) : (
        <>
          {onOpenProvenance && provenanceEntry === 'trailing' ? (
            <PreviewProvenanceButton
              item={item}
              onOpenProvenance={onOpenProvenance}
              tooltipClassName={tooltipClassName}
            />
          ) : null}
          <ManagedFileDownloadButton
            source={item.source ?? 'artifact'}
            path={item.path}
            suggestedName={item.name}
            className="bg-transparent shadow-none"
          />
          {item.originSession?.state === 'deleted' ? (
            <span
              data-testid="deleted-origin-session"
              className="shrink-0 rounded bg-warning-100 px-1.5 py-0.5 text-[10px] text-warning-900"
            >
              {t('previewSurface.sourceDeleted')}
            </span>
          ) : null}
          {onOpenProvenance && provenanceEntry === 'menu' ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-text-100 hover:text-text-000"
                  aria-label={`File actions for ${item.title}`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[70] min-w-36">
                <DropdownMenuItem onSelect={onOpenProvenance}>
                  <GitBranch className="mr-2 size-4" aria-hidden="true" />
                  Provenance
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      )}
      {onOpenFullScreen ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={`Open full screen preview of ${item.title}`}
                onClick={onOpenFullScreen}
              >
                <Maximize2 aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className={tooltipClassName}>
              {t('previewSurface.fullScreen')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-text-100 hover:text-text-000"
              aria-label={`Close preview of ${item.title}`}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className={tooltipClassName}>{t('previewSurface.close')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </header>
  )
}

type ArtifactVersionNavigationProps = {
  lineage: ArtifactLineageProvenance
  selectedVersionId: string | undefined
  onSelect: (versionId: string) => void
  // Edit/Compare affordances exist only for managed text artifacts; the surface gates them here so
  // the version bar stays a pure navigator for images/PDFs/notebooks.
  editableText: boolean
  canCompare: boolean
  onEdit: () => void
  onCompare: () => void
}

const ArtifactVersionNavigation = ({
  lineage,
  selectedVersionId,
  onSelect,
  editableText,
  canCompare,
  onEdit,
  onCompare
}: ArtifactVersionNavigationProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  const selectedIndex = lineage.versions.findIndex(
    (version) => version.versionId === selectedVersionId
  )
  if (selectedIndex < 0) return null

  const selectedVersion = lineage.versions[selectedIndex]
  // Only finalized Versions are listed: pending staging rows are transient and cannot be edited.
  const selectableVersions = lineage.versions
    .filter((version) => version.state === 'finalized')
    .reverse()

  return (
    <div
      data-testid="artifact-preview-version-navigation"
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border-300/60 px-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('previewFile.previousVersion')}
        disabled={selectedIndex <= 0}
        onClick={() => {
          const versionId = lineage.versions[selectedIndex - 1]?.versionId
          if (versionId) onSelect(versionId)
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('previewFile.chooseVersion')}
            className="gap-0.5 px-1.5 text-xs font-medium text-text-100"
          >
            v{selectedVersion.versionNumber}
            <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="z-[70] min-w-48">
          {selectableVersions.map((version) => (
            <DropdownMenuItem
              key={version.versionId}
              disabled={version.versionId === selectedVersionId}
              onSelect={() => onSelect(version.versionId)}
              data-version-number={version.versionNumber}
            >
              <span className="min-w-0 flex-1 truncate">v{version.versionNumber}</span>
              <span className="shrink-0 pl-3 text-[11px] text-text-300">
                {formatVersionTimestamp(version.createdAt)}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('previewFile.nextVersion')}
        disabled={selectedIndex >= lineage.versions.length - 1}
        onClick={() => {
          const versionId = lineage.versions[selectedIndex + 1]?.versionId
          if (versionId) onSelect(versionId)
        }}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
      {editableText ? (
        <div className="ml-auto flex items-center gap-0.5">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-text-100 hover:text-text-000"
                    aria-label={t('artifactCompare.openAction')}
                    disabled={!canCompare}
                    onClick={onCompare}
                  >
                    <GitCompare aria-hidden="true" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('artifactCompare.openAction')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-text-100 hover:text-text-000"
                    aria-label={t('artifactEdit.editAction')}
                    disabled={!editableText || selectedVersion.state !== 'finalized'}
                    onClick={onEdit}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('artifactEdit.editAction')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : null}
    </div>
  )
}

// The content slot is shared by both presentations so every supported file type follows the same
// renderer path. Callers can temporarily suppress it while another surface owns the preview.
const PreviewFileSurface = ({
  item,
  contentKey,
  renderContent = true,
  tooltipClassName,
  onClose,
  onOpenFullScreen,
  provenanceEntry = 'menu'
}: PreviewFileSurfaceProps): React.JSX.Element => {
  const [provenanceTarget, setProvenanceTarget] = useState<string>()
  // Bumping this token remounts the content tree so a local file is re-read from disk.
  const [reloadToken, setReloadToken] = useState(0)
  // Immutable Version selected as the edit source; opening the dialog freezes it so a lineage
  // refresh during editing never retargets the write.
  const [editTarget, setEditTarget] = useState<ArtifactVersionDescriptor>()
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareTargetVersionId, setCompareTargetVersionId] = useState<string | undefined>()
  const [versionOverride, setVersionOverride] = useState<{
    key: string
    item: PreviewFileItem
  }>()
  const [lineageResult, setLineageResult] = useState<{
    key: string
    value?: ArtifactLineageProvenance
  }>()
  const projectId = usePreviewWorkbenchStore((state) => state.activeProjectId)
  const storedItem = usePreviewWorkbenchStore((state) =>
    state.items.find((candidate) => candidate.id === item.id)
  )
  const itemIdentityKey = `${item.id}:${item.artifactId ?? ''}`
  const previewItem =
    storedItem?.type === 'file' && storedItem.artifactId === item.artifactId
      ? storedItem
      : versionOverride?.key === itemIdentityKey
        ? versionOverride.item
        : item
  const surfaceKey = item.id
  const showProvenance = provenanceTarget === surfaceKey
  const lineageKey = `${projectId ?? ''}:${previewItem.sessionId}:${previewItem.artifactId ?? ''}`
  // Finalization increments the owning Session's filesRevision even when this already-open preview
  // remains on an older Version. Include it in the request identity so the version navigator learns
  // about newly finalized Versions without forcing the user's current selection to change.
  const sessionFilesRevision = useSessionStore(
    (state) =>
      state.sessions.find((session) => session.id === previewItem.sessionId)?.filesRevision ?? 0
  )
  // A GENERATED-card click updates selectedVersionId on the stable preview tab. Refetch even when the
  // Artifact identity is unchanged; the cached lineage may predate that immutable Version.
  const lineageRequestKey = `${lineageKey}:${sessionFilesRevision}:${previewItem.selectedVersionId ?? ''}`
  const lineage = lineageResult?.key === lineageKey ? lineageResult.value : undefined
  const exactSelectedVersion = lineage?.versions.find(
    (version) => version.versionId === previewItem.selectedVersionId
  )
  const newestLoadedVersion = lineage?.versions.at(-1)
  const selectionIsNewerThanLoadedLineage =
    typeof previewItem.versionNumber === 'number' &&
    typeof newestLoadedVersion?.versionNumber === 'number' &&
    previewItem.versionNumber > newestLoadedVersion.versionNumber
  const selectedVersion =
    exactSelectedVersion ??
    (lineage && !selectionIsNewerThanLoadedLineage
      ? resolveArtifactVersionDescriptor(lineage, previewItem.selectedVersionId)
      : undefined)
  const selectedVersionId = selectedVersion?.versionId ?? previewItem.selectedVersionId
  const resolvedPreviewItem =
    selectedVersion && projectId
      ? createPreviewFileItemForArtifactVersion({
          item: previewItem,
          version: selectedVersion,
          projectId
        })
      : previewItem

  useEffect(() => {
    let active = true
    if (!projectId || !previewItem.artifactId || previewItem.source === 'upload') return

    void window.api.artifacts
      .getLineage({
        projectId,
        appSessionId: previewItem.sessionId,
        artifactId: previewItem.artifactId
      })
      .then((value) => {
        if (active) setLineageResult({ key: lineageKey, value })
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [
    lineageKey,
    lineageRequestKey,
    previewItem.artifactId,
    previewItem.sessionId,
    previewItem.source,
    projectId
  ])

  const applyVersionItem = (nextItem: PreviewFileItem): void => {
    setVersionOverride({ key: itemIdentityKey, item: nextItem })
    if (storedItem?.type === 'file' && storedItem.artifactId === item.artifactId) {
      usePreviewWorkbenchStore.getState().upsertItem(nextItem)
    }
  }

  const selectPreviewVersion = (versionId: string): void => {
    if (!lineage || !projectId) return
    const version = lineage.versions.find((candidate) => candidate.versionId === versionId)
    if (!version) return

    applyVersionItem(
      createPreviewFileItemForArtifactVersion({ item: previewItem, version, projectId })
    )
  }

  // Text-editable managed artifacts carry the edit/compare actions; uploads, local files, and
  // binary formats stay read-only previews.
  const editableText =
    previewItem.source === 'artifact' &&
    Boolean(previewItem.artifactId) &&
    EDITABLE_PREVIEW_FORMATS.has(previewItem.format)
  const finalizedVersions = (
    lineage?.versions.filter((version) => version.state === 'finalized') ?? []
  )
    .slice()
    .sort((left, right) => left.versionNumber - right.versionNumber)
  // Compare answers "what did this Version change?" — the selected Version needs a finalized
  // predecessor to diff against, so the first finalized Version never enables Compare.
  const finalizedSelectedIndex =
    selectedVersion?.state === 'finalized'
      ? finalizedVersions.findIndex((version) => version.versionId === selectedVersion.versionId)
      : -1
  const canCompare = editableText && finalizedVersions.length >= 2 && finalizedSelectedIndex > 0

  const handleOpenEdit = (): void => {
    if (!selectedVersion || selectedVersion.state !== 'finalized') return
    setEditTarget(selectedVersion)
  }

  const handleOpenCompare = (): void => {
    setCompareTargetVersionId(selectedVersion?.versionId)
    setCompareOpen(true)
  }

  // A user edit returns the freshly finalized Version file; jump the preview to it so the written
  // content is immediately visible, then let the lineage refetch refresh the navigator.
  const handleUserEditSaved = (version: ArtifactFile): void => {
    if (!projectId || !previewItem.artifactId) return
    const versionFile = version as ArtifactVersionFile
    const descriptor: ArtifactVersionDescriptor = {
      id: versionFile.id ?? versionFile.versionId,
      versionId: versionFile.versionId,
      artifactId: versionFile.artifactId,
      versionNumber: versionFile.versionNumber,
      checksum: versionFile.checksum ?? '',
      createdAt: versionFile.createdAt ?? new Date().toISOString(),
      state: 'finalized',
      projectName: versionFile.projectName,
      sessionId: versionFile.sessionId,
      runId: versionFile.runId,
      name: versionFile.name,
      size: versionFile.size,
      mtimeMs: versionFile.mtimeMs,
      producerRunId: versionFile.producerRunId,
      environment: versionFile.environment
    }
    applyVersionItem(
      createPreviewFileItemForArtifactVersion({ item: previewItem, version: descriptor, projectId })
    )
    setEditTarget(undefined)
  }

  return (
    <div className="flex size-full min-h-0 flex-col overflow-hidden">
      <PreviewFileHeader
        item={resolvedPreviewItem}
        onClose={onClose}
        onOpenFullScreen={onOpenFullScreen}
        onReload={() => setReloadToken((token) => token + 1)}
        provenanceEntry={provenanceEntry}
        onOpenProvenance={
          previewItem.source !== 'upload' && previewItem.artifactId && projectId
            ? () => setProvenanceTarget(surfaceKey)
            : undefined
        }
        tooltipClassName={tooltipClassName}
      />
      {!showProvenance && lineage ? (
        <ArtifactVersionNavigation
          lineage={lineage}
          selectedVersionId={selectedVersionId}
          onSelect={selectPreviewVersion}
          editableText={editableText}
          canCompare={canCompare}
          onEdit={handleOpenEdit}
          onCompare={handleOpenCompare}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto bg-bg-000">
        {showProvenance && projectId ? (
          <ArtifactProvenancePanel
            item={resolvedPreviewItem}
            projectId={projectId}
            onClose={() => setProvenanceTarget(undefined)}
            onVersionChange={applyVersionItem}
          />
        ) : renderContent ? (
          <PreviewFileContent
            key={`${contentKey ?? ''}:${previewItem.selectedVersionId ?? ''}:${reloadToken}`}
            item={resolvedPreviewItem}
          />
        ) : null}
      </div>
      {editTarget && projectId && previewItem.artifactId ? (
        <ArtifactEditDialog
          open
          name={editTarget.name}
          versionNumber={editTarget.versionNumber}
          projectId={projectId}
          sessionId={previewItem.sessionId}
          storageSessionId={previewItem.sessionId}
          sourceVersionId={editTarget.versionId}
          path={createArtifactVersionLocator({
            projectId,
            appSessionId: previewItem.sessionId,
            artifactId: previewItem.artifactId,
            versionId: editTarget.versionId
          })}
          contentType={previewItem.mimeType}
          monospace={previewItem.format === 'code' || previewItem.format === 'json'}
          onClose={() => setEditTarget(undefined)}
          onSaved={handleUserEditSaved}
        />
      ) : null}
      {compareOpen && projectId && previewItem.artifactId ? (
        <ArtifactCompareDialog
          open
          name={previewItem.name}
          projectId={projectId}
          sessionId={previewItem.sessionId}
          artifactId={previewItem.artifactId}
          versions={finalizedVersions}
          initialTargetVersionId={compareTargetVersionId}
          onClose={() => setCompareOpen(false)}
        />
      ) : null}
    </div>
  )
}

export { PreviewFileSurface }
