/**
 * Local parsing models, from the app's side: what this build ships, what is on disk, and the one way to
 * fetch one.
 *
 * Three things this module deliberately does not do:
 *   * it does not carry paths. The manifest reading is pathless (`ModelWeightManifestReport`), and the
 *     views below add no location either — the renderer never needs to know where a weight landed, and a
 *     settings panel that leaks folder layout is a settings panel that leaks user names.
 *   * it does not decide what may be downloaded. The refusal rules live in `planWeightDownload`, which the
 *     fetch primitive owns; this module maps a manifest entry onto the primitive's spec and hands it over.
 *   * it does not claim a model is verified because a file exists. `installed` means "a file of exactly
 *     the published size is cached"; the digest is checked when the weight is fetched and when it is
 *     loaded. A byte count is evidence of presence, and is named as exactly that.
 */

import { stat } from 'node:fs/promises'

import type { ModelWeightEntry } from './model-weight-manifest'
import {
  readShippedModelWeightManifest,
  type ModelWeightManifestReport
} from './model-weight-manifest-file'
import {
  downloadModelWeightsStreaming,
  modelWeightPath,
  streamUrlToFile,
  type WeightDownloadOutcome,
  type WeightSpec
} from './model-weight-cache'

/** A manifest entry as the renderer may see it: no url, no path. */
export type LocalParsingModelView = Readonly<{
  id: string
  revision: string
  publisher: string
  bytes: number
  license: string
  kind: ModelWeightEntry['kind']
  sha256: string
  publisherMd5?: string
  /** A file of exactly the published size is cached. Not a digest check — see the module header. */
  installed: boolean
}>

export type LocalParsingModelsView = Readonly<{
  report: ModelWeightManifestReport
  models: readonly LocalParsingModelView[]
}>

/** The fetch outcome, reduced to what a settings panel shows. */
export type LocalParsingDownloadView = Readonly<{
  status: WeightDownloadOutcome['status']
  modelId: string
  /** Present when the weight is now cached: the digest of the file that was verified. */
  verifiedSha256?: string
  message: string
}>

const installedBytesFor = async (cacheDir: string, spec: WeightSpec): Promise<boolean> => {
  try {
    const stats = await stat(modelWeightPath(cacheDir, spec.modelId))
    return stats.size === spec.bytes
  } catch {
    return false
  }
}

/** Maps a manifest entry onto the fetch primitive's spec. Field names differ; the meaning does not. */
export const weightSpecForEntry = (entry: ModelWeightEntry): WeightSpec => ({
  modelId: entry.id,
  url: entry.url,
  bytes: entry.bytes,
  sha256: entry.sha256,
  license: entry.license
})

/**
 * What the settings section shows: the reading of the shipped manifest (including the two ways it can be
 * unusable) plus, for every entry, whether a file of the published size is already cached.
 */
export const readLocalParsingModels = async (input: {
  cacheDir: string
  override?: string
  resourcesPath?: string
  fromDir: string
}): Promise<LocalParsingModelsView> => {
  const reading = readShippedModelWeightManifest({
    override: input.override,
    resourcesPath: input.resourcesPath,
    fromDir: input.fromDir
  })
  const entries = reading.state?.state === 'usable' ? reading.state.manifest.entries : []
  const models = await Promise.all(
    entries.map(async (entry) => ({
      id: entry.id,
      revision: entry.revision,
      publisher: entry.publisher,
      bytes: entry.bytes,
      license: entry.license,
      kind: entry.kind,
      sha256: entry.sha256,
      ...(entry.publisherMd5 ? { publisherMd5: entry.publisherMd5 } : {}),
      installed: await installedBytesFor(input.cacheDir, weightSpecForEntry(entry))
    }))
  )
  return { report: reading.report, models }
}

/**
 * Fetches one model, streaming to disk and verifying as it arrives. The refusal rules are the primitive's,
 * so a model with an unpublishable digest, or a fetch without consent, is refused here for the same reason
 * it is refused there — and nothing is left on disk when a transfer fails or a digest does not match.
 */
export const downloadLocalParsingModel = async (input: {
  id: string
  consent: boolean
  cacheDir: string
  override?: string
  resourcesPath?: string
  fromDir: string
  /** Test seam: the byte source. Defaults to the real network. */
  streamWeights?: typeof streamUrlToFile
}): Promise<LocalParsingDownloadView> => {
  const reading = readShippedModelWeightManifest({
    override: input.override,
    resourcesPath: input.resourcesPath,
    fromDir: input.fromDir
  })
  const entries = reading.state?.state === 'usable' ? reading.state.manifest.entries : []
  const specs = entries.map(weightSpecForEntry)
  const outcome = await downloadModelWeightsStreaming({
    modelId: input.id,
    cacheDir: input.cacheDir,
    specs,
    consent: input.consent,
    streamWeights: input.streamWeights ?? streamUrlToFile
  })
  return {
    status: outcome.status,
    modelId: input.id,
    ...('verifiedSha256' in outcome ? { verifiedSha256: outcome.verifiedSha256 } : {}),
    message: describeDownloadOutcome(outcome)
  }
}

/**
 * The message a user reads. The refusal states are the interesting ones: each says which rule stopped it,
 * because "could not verify" and "you have not agreed yet" are different answers to "why did nothing
 * happen".
 */
const describeDownloadOutcome = (outcome: WeightDownloadOutcome): string => {
  switch (outcome.status) {
    case 'cached':
      return '已在本地缓存，且校验值与本清单一致。'
    case 'downloaded':
      // The reader is told when the bytes did not come from the published location: a mirror was used, and
      // "downloaded" alone would hide that. Same sentence either way, one clause added when it is not origin.
      return outcome.via && outcome.via !== 'origin'
        ? `已下载并校验通过（经镜像 ${outcome.via}），可在本机离线使用。`
        : '已下载并校验通过，可在本机离线使用。'
    case 'needs-consent':
      return outcome.message
    case 'unresolved':
      return outcome.message
    case 'checksum-mismatch':
      return outcome.message
    case 'failed':
      return outcome.message
  }
}
