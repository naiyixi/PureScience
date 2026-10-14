import { create } from 'zustand'
import type { PluginOperationOutcomeView } from '../../../shared/plugin-source'
import type {
  SpecialistListItem,
  SpecialistProfileView,
  CreateSpecialistInput,
  UpdateSpecialistInput
} from '../../../shared/specialist'
import type {
  SpecialistPackageCandidatePreview,
  SpecialistPackageInstallResult,
  SpecialistExportPreview,
  SpecialistExportSaveResult,
  SpecialistDeletePreview,
  SpecialistDeleteResult
} from '../../../shared/specialist-package'
import type {
  PluginSourceCandidatePreview,
  PluginSourcePreview
} from '../../../shared/plugin-source'

type SpecialistStoreData = {
  items: SpecialistListItem[]
  isLoaded: boolean
  packagePreview?: SpecialistPackageCandidatePreview
  // E2/E3: what the plugin creator read from a public repository, and the token that names it.
  pluginSourceCandidate?: PluginSourceCandidatePreview<PluginSourcePreview>
  // E3-2: what the last deploy / run-once answered — codes and parameters, so the block that
  // renders it can build its own sentences in the reader's language.
  pluginOperation?: PluginOperationOutcomeView
  exportPreview?: SpecialistExportPreview
}

type SpecialistStoreActions = {
  load: () => Promise<void>
  create: (input: CreateSpecialistInput) => Promise<SpecialistProfileView>
  update: (input: UpdateSpecialistInput) => Promise<SpecialistProfileView>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  previewDelete: (id: string) => Promise<SpecialistDeletePreview>
  delete: (
    id: string,
    expectedRevision: number,
    deleteSkillIds: readonly string[]
  ) => Promise<SpecialistDeleteResult>
  duplicate: (id: string) => Promise<CreateSpecialistInput>
  selectPackage: () => Promise<{ cancelled: true } | SpecialistPackageCandidatePreview>
  installPackage: (confirmOverwrite?: boolean) => Promise<SpecialistPackageInstallResult>
  cancelPackage: () => Promise<void>
  previewPluginSource: (
    reference: string
  ) => Promise<PluginSourceCandidatePreview<PluginSourcePreview>>
  clearPluginSource: () => Promise<void>
  deployPluginSource: (token: string, confirmed: boolean) => Promise<PluginOperationOutcomeView>
  runPluginSourceOnce: (token: string, confirmed: boolean) => Promise<PluginOperationOutcomeView>
  clearPluginOperation: () => void
  previewExport: (specialistId: string) => Promise<SpecialistExportPreview>
  exportSpecialist: (
    preview: SpecialistExportPreview,
    includedSkillIds: readonly string[]
  ) => Promise<SpecialistExportSaveResult>
  clearExport: () => void
}

type SpecialistStore = SpecialistStoreData & SpecialistStoreActions

let latestExportPreviewRequest = 0

const useSpecialistStore = create<SpecialistStore>((set) => ({
  items: [],
  isLoaded: false,
  packagePreview: undefined,
  pluginSourceCandidate: undefined,
  pluginOperation: undefined,
  exportPreview: undefined,

  load: async () => {
    // Guard: specialist.list is Electron-only and unavailable in the web gateway.
    if (typeof window.api?.specialist?.list !== 'function') {
      set({ items: [], isLoaded: true })
      return
    }
    const items = await window.api.specialist.list()
    set({ items, isLoaded: true })
  },

  create: async (input: CreateSpecialistInput) => {
    const view = await window.api.specialist.create(input)
    // Reload the full list so Reviewer and ordering stay consistent.
    const items = await window.api.specialist.list()
    set({ items })
    return view
  },

  update: async (input: UpdateSpecialistInput) => {
    const view = await window.api.specialist.update(input)
    // Reload the full list so Reviewer and ordering stay consistent.
    const items = await window.api.specialist.list()
    set({ items })
    return view
  },

  setEnabled: async (id: string, enabled: boolean) => {
    await window.api.specialist.setEnabled({ id, enabled })
    const items = await window.api.specialist.list()
    set({ items })
  },

  previewDelete: async (id: string) => window.api.specialist.previewDelete({ id }),

  delete: async (id: string, expectedRevision: number, deleteSkillIds: readonly string[]) => {
    const result = await window.api.specialist.delete({ id, expectedRevision, deleteSkillIds })
    if (result.status === 'deleted') {
      const items = await window.api.specialist.list()
      set({ items })
    }
    return result
  },

  duplicate: async (id: string) => window.api.specialist.duplicate({ id }),

  selectPackage: async () => {
    const result = await window.api.specialist.selectPackage()
    set({ packagePreview: 'cancelled' in result ? undefined : result })
    return result
  },

  installPackage: async (confirmOverwrite = false) => {
    const preview = useSpecialistStore.getState().packagePreview
    if (!preview) return { status: 'failed', code: 'candidate-invalid' }
    const result = await window.api.specialist.installPackage({
      candidateToken: preview.candidateToken,
      ...(confirmOverwrite ? { confirmOverwrite: true as const } : {})
    })
    if (result.status === 'installed') {
      const items = await window.api.specialist.list()
      set({ items, packagePreview: undefined })
    }
    return result
  },

  cancelPackage: async () => {
    const preview = useSpecialistStore.getState().packagePreview
    if (preview) {
      await window.api.specialist.cancelPackage({ candidateToken: preview.candidateToken })
    }
    set({ packagePreview: undefined })
  },

  previewPluginSource: async (reference) => {
    const candidate = await window.api.specialist.pluginSourcePreview({ reference })
    // The refusal is kept as it came: a preview that could not be read is still an answer, and the
    // block that renders it names why instead of showing an empty form.
    set({ pluginSourceCandidate: candidate })
    return candidate
  },

  clearPluginSource: async () => {
    const candidate = useSpecialistStore.getState().pluginSourceCandidate
    if (candidate) await window.api.specialist.pluginSourceCancel()
    set({ pluginSourceCandidate: undefined })
  },

  // The outcome is kept even when it is a refusal: a refusal is an answer, and the block shows why.
  deployPluginSource: async (token, confirmed) => {
    const outcome = await window.api.specialist.pluginSourceDeploy({ token, confirmed })
    set({ pluginOperation: outcome })
    return outcome
  },

  runPluginSourceOnce: async (token, confirmed) => {
    const outcome = await window.api.specialist.pluginSourceRunOnce({ token, confirmed })
    set({ pluginOperation: outcome })
    return outcome
  },

  clearPluginOperation: () => set({ pluginOperation: undefined }),

  previewExport: async (specialistId: string) => {
    const requestId = ++latestExportPreviewRequest
    const preview = await window.api.specialist.previewExport({ specialistId })
    if (requestId === latestExportPreviewRequest) set({ exportPreview: preview })
    return preview
  },

  exportSpecialist: async (
    preview: SpecialistExportPreview,
    includedSkillIds: readonly string[]
  ) => {
    return window.api.specialist.exportSpecialist({
      specialistId: preview.specialistId,
      expectedRevision: preview.expectedRevision,
      includedSkillIds
    })
  },

  clearExport: () => {
    latestExportPreviewRequest += 1
    set({ exportPreview: undefined })
  }
}))

export { useSpecialistStore }
