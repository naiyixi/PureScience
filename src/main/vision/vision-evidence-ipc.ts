import { ipcMainHandle } from '../ipc-handler-registry'
import type { VisionEvidenceSummary } from '../../shared/vision-evidence'
import type { VisionEvidenceReader } from './vision-evidence-repository'

// Read-only window channel for the vision-evidence cache: which image was translated by the vision model, under
// which extractor generation and evidence schema. Nothing here writes, and the evidence payload itself never
// crosses — see `VisionEvidenceSummary` for why.
export const VISION_EVIDENCE_CHANNEL = 'diagnostics:list-vision-evidence'

export type VisionEvidenceListRequest = Readonly<{
  sessionId?: string
  projectId?: string
  limit?: number
}>

export type VisionEvidenceCommandOwner = Readonly<{
  listEvidence: (request?: VisionEvidenceListRequest) => Promise<VisionEvidenceSummary[]>
}>

/** Wraps the repository's reader half; the owner is what the IPC registrar takes. */
export const createVisionEvidenceCommandOwner = (
  reader: VisionEvidenceReader
): VisionEvidenceCommandOwner => ({
  listEvidence: (request) => reader.list(request ?? {})
})

export const registerVisionEvidenceIpcHandlers = (
  owner: VisionEvidenceCommandOwner
): VisionEvidenceCommandOwner => {
  ipcMainHandle(VISION_EVIDENCE_CHANNEL, (_event, request: VisionEvidenceListRequest | undefined) =>
    owner.listEvidence(request)
  )
  return owner
}
