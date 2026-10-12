import { create } from 'zustand'

import type { NotebookSessionReference } from '../../../shared/notebook'
import type { StructureSelection } from '../../../shared/structure-selection'
import {
  normalizeStructureSelectionLabel,
  type StructureSelectionLabel
} from '../../../shared/structure-selection-label'
import type { StructureMeasurement } from '../../../shared/structure-measurement'
import type { ProjectFileOriginSession } from '../../../shared/project-files'
import type { FindingLocator } from '../../../shared/reviewer'
import type { UploadedAttachment } from '../../../shared/uploads'
import { getUploadedAttachmentPath } from '../../../shared/uploads'

export type PreviewPanelState = 'open' | 'collapsed'
export type PreviewFileFormat =
  | 'code'
  | 'markdown'
  | 'text'
  | 'json'
  | 'csv'
  | 'fasta'
  | 'html'
  | 'image'
  | 'tiff'
  | 'pdb'
  | 'molecule'
  | 'pdf'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'notebook'
  | 'unknown'
// Distinguishes generated artifacts from user uploads, notebook inputs, and local ("This computer")
// files when preview readers and header actions differ. 'local' files live outside app storage:
// their path is an absolute filesystem path read via window.api.localFs.
export type PreviewFileSource = 'artifact' | 'upload' | 'notebook-input' | 'local'
export const PROJECT_FILES_PREVIEW_ID = 'tool:project:files'

type PreviewItemBase = {
  id: string
  projectId?: string
  sessionId: string
  title: string
}

export type PreviewFileItem = PreviewItemBase & {
  type: 'file'
  source?: PreviewFileSource
  path: string
  format: PreviewFileFormat
  name: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  artifactId?: string
  selectedVersionId?: string
  versionNumber?: number
  originSession?: ProjectFileOriginSession
}

// Runtime-only web-source tabs: an agent-response HTTPS link opened inside the sandboxed right
// panel. Deliberately excluded from persistence below — a restored web tab would silently re-fetch
// an external document long after the user asked to view it.
export type PreviewWebItem = PreviewItemBase & {
  type: 'web'
  url: string
}

// Tool previews share the workbench chrome with files, but keep their own render path.
export type PreviewToolItem = PreviewItemBase & {
  type: 'tool'
  toolKind?: 'notebook' | 'files' | 'reviewer' | 'plan'
  notebook?: NotebookSessionReference
  // Reviewer-specific: which session's reviews to show, which review to select, and the active
  // finding to scroll to.
  reviewerSessionId?: string
  reviewerReviewId?: string
  reviewerActiveFindingId?: string
  planArtifactVersionId?: string
}

export type PreviewItem = PreviewFileItem | PreviewToolItem | PreviewWebItem

type StoredPreviewItem = PreviewItem & {
  createdAt: number
  updatedAt: number
}

// The preview state for a single project. The store keeps the active project's slice at top level and
// stashes inactive projects' slices in `byProject` so switching projects never shows another's tabs.
type PreviewSlice = {
  items: StoredPreviewItem[]
  activeItemId: string | undefined
  panelState: PreviewPanelState
  openRequestVersion: number
}

// The durable subset restored from persistence when a project is first activated in a session.
export type RestoredPreviewSlice = {
  items?: PreviewItem[]
  activeItemId?: string
  panelState?: PreviewPanelState
}

type PreviewWorkbenchStoreData = PreviewSlice & {
  activeProjectId: string | undefined
  byProject: Record<string, PreviewSlice>
  // Tool tab currently shown as a large modal instead of inline panel content (files tab only).
  expandedToolItemId: string | null
  // A one-off file preview stays outside the tab list so Files and Global Search can open the same
  // dialog without creating a durable workbench tab.
  fileDialogItem: PreviewFileItem | undefined
  // D2: the structure region each open preview tab currently has selected, keyed by tab id.
  // Transient view state, never persisted: it describes what is on screen right now, and the tab that
  // owned it drops its entry when it closes (a stale selection must not ride into a later turn).
  structureSelections: Record<string, StructureSelection>
  // D3: the geometry each structure tab currently has measured (distance/angle), keyed by tab id.
  // Transient like the selections above: it describes what is on screen right now.
  structureMeasurements: Record<string, StructureMeasurement>
  // D4: the name (and marker colour) the user gave the region on a structure tab, keyed by tab id.
  // It lives NEXT TO the selection rather than inside it on purpose: the name is not part of the region's
  // recomputable identity (the fingerprint), and a name that outlived its region would point at the wrong
  // residues. So the two are set and dropped together — see setStructureSelection / setStructureSelectionLabel.
  structureSelectionLabels: Record<string, StructureSelectionLabel>
}

type PreviewWorkbenchStore = PreviewWorkbenchStoreData & {
  activateProject: (projectId: string, restored?: RestoredPreviewSlice) => void
  /** Records (or clears, with `undefined`) the structure selection of one preview tab. */
  setStructureSelection: (itemId: string, selection: StructureSelection | undefined) => void
  /** The selection that applies to a turn on `sessionId`, or undefined when there is none to send. */
  activeStructureSelection: (sessionId: string) => StructureSelection | undefined
  /**
   * Names (or re-colours) the region of one preview tab; `undefined` clears the name.
   * Refused when that tab has no selection: a name with nothing to name is not a state worth having.
   */
  setStructureSelectionLabel: (itemId: string, label: StructureSelectionLabel | undefined) => void
  /** The name that applies to a turn on `sessionId`, or undefined when the region is unnamed. */
  activeStructureSelectionLabel: (sessionId: string) => StructureSelectionLabel | undefined
  /** Records (or clears, with `undefined`) the measurement of one preview tab. */
  setStructureMeasurement: (itemId: string, measurement: StructureMeasurement | undefined) => void
  /** The measurement that applies to a turn on `sessionId`, or undefined when there is none. */
  activeStructureMeasurement: (sessionId: string) => StructureMeasurement | undefined
  reconcileFinalizedUploads: (uploads: UploadedAttachment[]) => void
  upsertItem: (item: PreviewItem) => void
  upsertAndActivateItem: (item: PreviewItem) => void
  activateItem: (itemId: string) => void
  removeItem: (itemId: string) => void
  removeSessionItems: (sessionId: string) => void
  setToolItemExpanded: (itemId: string | null) => void
  openFileDialog: (item: PreviewFileItem) => void
  closeFileDialog: () => void
  openPanel: () => void
  collapsePanel: () => void
  togglePanel: () => void
  syncPanelState: (panelState: PreviewPanelState) => void
}

// Creates a fresh transient preview workbench state for the app and isolated tests.
export const createInitialPreviewWorkbenchState = (): PreviewWorkbenchStoreData => ({
  items: [],
  activeItemId: undefined,
  panelState: 'collapsed',
  openRequestVersion: 0,
  activeProjectId: undefined,
  byProject: {},
  expandedToolItemId: null,
  fileDialogItem: undefined,
  structureSelections: {},
  structureSelectionLabels: {},
  structureMeasurements: {}
})

// The empty slice a project starts from before any preview tabs are opened.
const createEmptyPreviewSlice = (): PreviewSlice => ({
  items: [],
  activeItemId: undefined,
  panelState: 'collapsed',
  openRequestVersion: 0
})

// Preview capabilities are project-scoped. Persisted tabs created before project scope was stored
// are repaired from the owning workbench slice, and callers cannot accidentally omit that scope.
const withProjectScope = (item: PreviewItem, projectId: string | undefined): PreviewItem =>
  item.type === 'file' && !item.projectId && projectId ? { ...item, projectId } : item

// Normalizes incoming preview items so callers never persist or manage timestamps themselves.
const createStoredPreviewItem = (
  item: PreviewItem,
  existingItem?: StoredPreviewItem
): StoredPreviewItem => {
  const now = Date.now()

  return {
    ...item,
    createdAt: existingItem?.createdAt ?? now,
    updatedAt: now
  } as StoredPreviewItem
}

// Rebuilds a project's live slice from its persisted durable subset, repairing a dangling active tab.
const restoredToSlice = (restored: RestoredPreviewSlice, projectId: string): PreviewSlice => {
  const items = (restored.items ?? []).map((item) =>
    createStoredPreviewItem(withProjectScope(item, projectId))
  )
  const activeItemId = items.some((item) => item.id === restored.activeItemId)
    ? restored.activeItemId
    : items[0]?.id

  return {
    items,
    activeItemId,
    panelState: items.length > 0 ? (restored.panelState ?? 'collapsed') : 'collapsed',
    openRequestVersion: 0
  }
}

// Builds the stable preview tab identity for the notebook attached to one chat session.
const createNotebookPreviewItem = (notebook: NotebookSessionReference): PreviewToolItem => ({
  id: `tool:${notebook.sessionId}:notebook`,
  sessionId: notebook.sessionId,
  type: 'tool',
  toolKind: 'notebook',
  title: 'Notebook',
  notebook
})

const createSessionPlanPreviewItem = (
  sessionId: string,
  projectId: string,
  artifactVersionId?: string
): PreviewToolItem => ({
  id: `tool:${sessionId}:plan${artifactVersionId ? `:${artifactVersionId}` : ''}`,
  projectId,
  sessionId,
  type: 'tool',
  toolKind: 'plan',
  title: 'Session Plan',
  ...(artifactVersionId ? { planArtifactVersionId: artifactVersionId } : {})
})

// Builds the stable project-level preview tab that owns the file library surface.
const createProjectFilesPreviewItem = (): PreviewToolItem => ({
  id: PROJECT_FILES_PREVIEW_ID,
  sessionId: '__project_files__',
  type: 'tool',
  toolKind: 'files',
  title: 'Files'
})

// Input for opening the Session reviewer panel; findingId/locator determine scroll position.
export type SessionReviewerPreviewInput = {
  sessionId: string
  /** Absent when the entry point is the session itself (no review yet) rather than one finding's review. */
  reviewId?: string
  findingId: string | undefined
  locator: FindingLocator | undefined
}

// Builds a stable preview tab for the Session reviewer panel scoped to one session. The id is
// session-scoped so "Go to transcript" from any card in the same session reuses the same tab.
const createSessionReviewerPreviewItem = (input: SessionReviewerPreviewInput): PreviewToolItem => ({
  id: `tool:${input.sessionId}:reviewer`,
  sessionId: input.sessionId,
  type: 'tool',
  toolKind: 'reviewer',
  title: 'Session Reviewer',
  reviewerSessionId: input.sessionId,
  reviewerReviewId: input.reviewId,
  reviewerActiveFindingId: input.findingId
})

// Builds the stable preview tab identity for one HTTPS source link inside a session. The id is
// URL-scoped, not message-scoped, so clicking the same source from different replies reuses one tab.
export const createWebPreviewItem = (
  sessionId: string,
  url: string,
  title?: string
): PreviewWebItem => {
  let host = url
  try {
    host = new URL(url).hostname
  } catch {
    // Keep the raw URL as the fallback label when parsing fails.
  }

  return {
    id: `web:${sessionId}:${url}`,
    sessionId,
    type: 'web',
    url,
    title: title?.trim() || host
  }
}

// Drops the selection entries of tabs that no longer exist. Object identity is preserved when nothing
// changes, so a removal that carries no structure tab does not wake every subscriber.
const withoutEntries = <Value>(
  entries: Record<string, Value>,
  removedItemIds: ReadonlySet<string>
): Record<string, Value> => {
  const kept = Object.keys(entries).filter((itemId) => !removedItemIds.has(itemId))
  if (kept.length === Object.keys(entries).length) return entries

  const next: Record<string, Value> = {}
  for (const itemId of kept) next[itemId] = entries[itemId]
  return next
}

// Chooses a stable fallback tab when the active preview item is removed.
const getRepairedActiveItemId = (
  items: StoredPreviewItem[],
  removedIndex: number
): string | undefined => {
  if (items.length === 0) return undefined

  return items[Math.min(removedIndex, items.length - 1)]?.id
}

// Updates matching upload tabs while preserving array identity when no item changes.
const reconcileUploadPreviewItems = (
  items: StoredPreviewItem[],
  uploadByPreviewId: Map<string, UploadedAttachment>,
  updatedAt: number
): StoredPreviewItem[] => {
  let changed = false
  const reconciledItems = items.map((item) => {
    if (item.type !== 'file' || item.source !== 'upload') return item

    const upload = uploadByPreviewId.get(item.id)
    if (!upload) return item
    const path = getUploadedAttachmentPath(upload, item.projectId)
    if (path === item.path && upload.sessionId === item.sessionId) return item

    changed = true
    return { ...item, sessionId: upload.sessionId, path, updatedAt }
  })

  return changed ? reconciledItems : items
}

export const usePreviewWorkbenchStore = create<PreviewWorkbenchStore>((set, get) => ({
  ...createInitialPreviewWorkbenchState(),

  // Switches the visible preview slice to a project's own tabs, stashing the outgoing project's slice
  // so returning to it restores its tabs. `restored` seeds a project's slice from persistence on first
  // activation in this session.
  activateProject: (projectId, restored) => {
    set((state) => {
      if (state.activeProjectId === projectId) return state

      const byProject = { ...state.byProject }

      if (state.activeProjectId) {
        byProject[state.activeProjectId] = {
          items: state.items,
          activeItemId: state.activeItemId,
          panelState: state.panelState,
          openRequestVersion: state.openRequestVersion
        }
      }

      const targetSlice =
        byProject[projectId] ??
        (restored ? restoredToSlice(restored, projectId) : createEmptyPreviewSlice())

      // The active slice lives at top level, never duplicated in the stash.
      delete byProject[projectId]

      // The expanded files surface is tied to the outgoing project's workbench layout.
      return {
        ...targetSlice,
        panelState: targetSlice.items.length > 0 ? targetSlice.panelState : 'collapsed',
        activeProjectId: projectId,
        byProject,
        expandedToolItemId: null,
        fileDialogItem:
          state.fileDialogItem?.projectId === projectId ? state.fileDialogItem : undefined
      }
    })
  },

  // Repairs already-open upload tabs after staged files move into their permanent session folder.
  reconcileFinalizedUploads: (uploads) => {
    if (uploads.length === 0) return

    const uploadByPreviewId = new Map(uploads.map((upload) => [`upload:${upload.id}`, upload]))
    const updatedAt = Date.now()

    set((state) => {
      const items = reconcileUploadPreviewItems(state.items, uploadByPreviewId, updatedAt)
      let byProject = state.byProject

      // Repair inactive project slices too without creating tabs for uploads never opened by users.
      for (const [projectId, slice] of Object.entries(state.byProject)) {
        const reconciledItems = reconcileUploadPreviewItems(
          slice.items,
          uploadByPreviewId,
          updatedAt
        )
        if (reconciledItems === slice.items) continue

        if (byProject === state.byProject) byProject = { ...state.byProject }
        byProject[projectId] = { ...slice, items: reconciledItems }
      }

      if (items === state.items && byProject === state.byProject) return state

      return { items, byProject }
    })
  },

  // Records the region a structure tab currently has selected; `undefined` clears it (the pane closed,
  // or the file it was showing was replaced).
  setStructureSelection: (itemId, selection) => {
    set((state) => {
      if (!selection) {
        if (!(itemId in state.structureSelections) && !(itemId in state.structureSelectionLabels)) {
          return state
        }
        // The name goes with the region: a name left behind would describe a region that is no longer
        // selected (and the chip would show a name over nothing).
        return {
          structureSelections: withoutEntries(state.structureSelections, new Set([itemId])),
          structureSelectionLabels: withoutEntries(
            state.structureSelectionLabels,
            new Set([itemId])
          )
        }
      }

      const previous = state.structureSelections[itemId]
      // Same value twice (a re-render, a repeated click on the same residue) must not churn the map.
      if (previous && JSON.stringify(previous) === JSON.stringify(selection)) return state

      // A different region means the old name no longer describes what is selected, so it is dropped
      // rather than silently re-pointed at other residues.
      return {
        structureSelections: { ...state.structureSelections, [itemId]: selection },
        structureSelectionLabels: withoutEntries(state.structureSelectionLabels, new Set([itemId]))
      }
    })
  },

  // Names the region of one tab. Normalised here (not only at the input): an empty name is the same
  // thing as no name, and the store is the single place that decides that for every caller.
  setStructureSelectionLabel: (itemId, label) => {
    const normalized = normalizeStructureSelectionLabel(label)
    set((state) => {
      const previous = state.structureSelectionLabels[itemId]
      const clearing = normalized === undefined

      if (!clearing && !(itemId in state.structureSelections)) {
        // A name with nothing to name would render as a chip over an empty region.
        return state
      }
      if (clearing) {
        if (!previous) return state
        return {
          structureSelectionLabels: withoutEntries(
            state.structureSelectionLabels,
            new Set([itemId])
          )
        }
      }
      // Same value twice must not churn the map (every write on this path is reference-stable).
      if (previous && JSON.stringify(previous) === JSON.stringify(normalized)) return state
      return {
        structureSelectionLabels: { ...state.structureSelectionLabels, [itemId]: normalized }
      }
    })
  },

  activeStructureSelectionLabel: (sessionId) => {
    const state = get()
    const activeItemId = state.activeItemId
    if (!activeItemId) return undefined

    const item = state.items.find((candidate) => candidate.id === activeItemId)
    if (!item || item.type !== 'file' || item.sessionId !== sessionId) return undefined

    // No region, no name: the two are one thing on screen even though they are stored separately.
    if (!state.structureSelections[activeItemId]) return undefined
    return state.structureSelectionLabels[activeItemId]
  },

  // Same shape as the selection above, for a measured distance/angle.
  setStructureMeasurement: (itemId, measurement) => {
    set((state) => {
      if (!measurement) {
        if (!(itemId in state.structureMeasurements)) return state
        return {
          structureMeasurements: withoutEntries(state.structureMeasurements, new Set([itemId]))
        }
      }

      const previous = state.structureMeasurements[itemId]
      if (previous && JSON.stringify(previous) === JSON.stringify(measurement)) return state

      return { structureMeasurements: { ...state.structureMeasurements, [itemId]: measurement } }
    })
  },

  activeStructureMeasurement: (sessionId) => {
    const state = get()
    const activeItemId = state.activeItemId
    if (!activeItemId) return undefined

    const item = state.items.find((candidate) => candidate.id === activeItemId)
    if (!item || item.type !== 'file' || item.sessionId !== sessionId) return undefined

    return state.structureMeasurements[activeItemId]
  },

  // The selection a turn on this session should carry: only when the structure tab is the one in front
  // (a selection the user has navigated away from is no longer what they are looking at).
  activeStructureSelection: (sessionId) => {
    const state = get()
    const activeItemId = state.activeItemId
    if (!activeItemId) return undefined

    const item = state.items.find((candidate) => candidate.id === activeItemId)
    if (!item || item.type !== 'file' || item.sessionId !== sessionId) return undefined

    return state.structureSelections[activeItemId]
  },

  // Inserts a preview item or refreshes the existing tab without changing focus.
  upsertItem: (item) => {
    set((state) => {
      const scopedItem = withProjectScope(item, state.activeProjectId)
      const existingIndex = state.items.findIndex((previewItem) => previewItem.id === scopedItem.id)

      // New items append to the horizontal preview list in discovery order.
      if (existingIndex === -1) {
        const hasActiveItem = state.items.some(
          (previewItem) => previewItem.id === state.activeItemId
        )

        return {
          items: [...state.items, createStoredPreviewItem(scopedItem)],
          // Passive discovery selects a fallback tab without opening the collapsed panel.
          activeItemId: hasActiveItem ? state.activeItemId : (state.items[0]?.id ?? scopedItem.id)
        }
      }

      // Existing items keep their original position and creation time.
      return {
        items: state.items.map((previewItem, index) =>
          index === existingIndex ? createStoredPreviewItem(scopedItem, previewItem) : previewItem
        )
      }
    })
  },

  // Opens the panel and activates the item for first-time preview requests.
  upsertAndActivateItem: (item) => {
    get().upsertItem(item)
    set((state) => ({
      activeItemId: item.id,
      panelState: 'open',
      openRequestVersion: state.openRequestVersion + 1
    }))
  },

  // Moves focus only to an item that is still present in the preview list.
  activateItem: (itemId) => {
    if (!get().items.some((item) => item.id === itemId)) return

    set({ activeItemId: itemId })
  },

  // Removes one preview tab and repairs focus if the active tab disappeared.
  removeItem: (itemId) => {
    set((state) => {
      const removedIndex = state.items.findIndex((item) => item.id === itemId)

      if (removedIndex === -1) return state

      const items = state.items.filter((item) => item.id !== itemId)
      const activeItemId =
        state.activeItemId === itemId
          ? getRepairedActiveItemId(items, removedIndex)
          : state.activeItemId

      return {
        items,
        activeItemId,
        panelState: items.length > 0 ? state.panelState : 'collapsed',
        expandedToolItemId: state.expandedToolItemId === itemId ? null : state.expandedToolItemId,
        fileDialogItem: itemId === PROJECT_FILES_PREVIEW_ID ? undefined : state.fileDialogItem,
        structureSelections: withoutEntries(state.structureSelections, new Set([itemId])),
        structureSelectionLabels: withoutEntries(state.structureSelectionLabels, new Set([itemId])),
        structureMeasurements: withoutEntries(state.structureMeasurements, new Set([itemId]))
      }
    })
  },

  // Drops all preview tabs owned by a deleted session and keeps focus on a valid tab.
  removeSessionItems: (sessionId) => {
    set((state) => {
      const firstRemovedIndex = state.items.findIndex((item) => item.sessionId === sessionId)

      if (firstRemovedIndex === -1) return state

      const items = state.items.filter((item) => item.sessionId !== sessionId)
      const activeItemId = items.some((item) => item.id === state.activeItemId)
        ? state.activeItemId
        : getRepairedActiveItemId(items, firstRemovedIndex)
      const removedItemIds = new Set(
        state.items.filter((item) => item.sessionId === sessionId).map((item) => item.id)
      )

      return {
        items,
        activeItemId,
        structureSelections: withoutEntries(state.structureSelections, removedItemIds),
        structureSelectionLabels: withoutEntries(state.structureSelectionLabels, removedItemIds),
        structureMeasurements: withoutEntries(state.structureMeasurements, removedItemIds),
        // A session-scoped tool tab could own the expanded surface; clear it when its tab is gone.
        panelState: items.length > 0 ? state.panelState : 'collapsed',
        expandedToolItemId: items.some((item) => item.id === state.expandedToolItemId)
          ? state.expandedToolItemId
          : null,
        fileDialogItem:
          state.fileDialogItem?.sessionId === sessionId ? undefined : state.fileDialogItem
      }
    })
  },

  // Expands a tool tab (files) into a large modal surface, or restores the inline panel layout.
  setToolItemExpanded: (itemId) => {
    set({ expandedToolItemId: itemId })
  },

  openFileDialog: (item) => set({ fileDialogItem: item }),

  closeFileDialog: () => set({ fileDialogItem: undefined }),

  // Records an explicit open request so the resizable panel can expand even if it is already open.
  openPanel: () => {
    if (get().items.length === 0) return

    set((state) => ({
      panelState: 'open',
      openRequestVersion: state.openRequestVersion + 1
    }))
  },

  // Stores the manual collapsed state without changing preview item data.
  collapsePanel: () => {
    set({ panelState: 'collapsed' })
  },

  // Keeps the header toggle behavior centralized with the panel state.
  togglePanel: () => {
    if (get().panelState === 'collapsed') {
      get().openPanel()
      return
    }

    get().collapsePanel()
  },

  // Mirrors resize-library state into the store after drag or imperative panel changes.
  syncPanelState: (panelState) => {
    set((state) => ({
      panelState: panelState === 'open' && state.items.length === 0 ? 'collapsed' : panelState
    }))
  }
}))

// createWebPreviewItem is exported at its declaration above.
export {
  createNotebookPreviewItem,
  createProjectFilesPreviewItem,
  createSessionPlanPreviewItem,
  createSessionReviewerPreviewItem
}
