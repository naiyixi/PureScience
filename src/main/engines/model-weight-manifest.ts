/**
 * The local-parsing-model manifest: the *data* half of the verified-download discipline.
 *
 * Shape follows the two precedents already in this repo — `scripts/micromamba-versions.json` (a data file
 * holding a pinned version plus its digests, so re-pinning is a data edit, never a code edit) and
 * `WeightSpec` in `model-weight-cache.ts` (what the download primitive actually consumes: modelId,
 * sha256, bytes, license, url). The manifest adds what a *publisher* owes a reader: who published it and
 * which revision of which capability it is.
 *
 * This module is deliberately pure: no filesystem, no network, no crypto import. It answers one question
 * — "is this manifest usable as a publisher's manifest?" — and the build gate and the offline read path
 * both ask it. A digest that is not 64 hex characters is not a digest; an entry without a license cannot
 * be redistributed by us; a duplicate id@revision would make two different files claim one identity.
 */

export type ModelWeightKind =
  'document-parse' | 'structure-recognition' | 'illustration' | 'fallback-engine'

export type ModelWeightEntry = {
  /** Stable identity of the capability slot, e.g. `doc-parse-primary`. */
  id: string
  /** The exact revision we pinned. `latest` is never acceptable: it is not reproducible. */
  revision: string
  /** Who published the bytes we host. Ourselves when we redistribute, so this is never blank. */
  publisher: string
  /** https URL of the exact revision (our release asset once published from here). */
  url: string
  /** 64 lowercase hex characters of the bytes at `url`. */
  sha256: string
  /** Exact byte length of the bytes at `url`. */
  bytes: number
  /** License of the redistributed bytes, as its own name. Empty is a refusal, not a warning. */
  license: string
  kind: ModelWeightKind
  /** Optional: an md5 the author published, kept for cross-checking our own copy. */
  publisherMd5?: string
  /** Optional: why this entry exists, in the reader's terms. */
  note?: string
}

export type ModelWeightManifest = {
  schema: 1
  /** The manifest's own revision; bumped whenever entries change. */
  revision: string
  entries: ModelWeightEntry[]
}

export type ModelWeightManifestProblem = {
  /** Index in `entries`, or -1 for problems about the manifest itself. */
  index: number
  field: string
  message: string
}

const isHex64 = (value: unknown): boolean =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const KINDS: readonly ModelWeightKind[] = [
  'document-parse',
  'structure-recognition',
  'illustration',
  'fallback-engine'
]

/**
 * Validates a parsed manifest. Returns every problem rather than the first, because a publisher fixing
 * one field at a time is how a half-checked manifest ships. An empty problem list is the only pass.
 */
export const validateModelWeightManifest = (value: unknown): ModelWeightManifestProblem[] => {
  const problems: ModelWeightManifestProblem[] = []
  const fail = (index: number, field: string, message: string): void => {
    problems.push({ index, field, message })
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(-1, 'manifest', 'manifest must be an object')
    return problems
  }
  const manifest = value as Partial<ModelWeightManifest>

  if (manifest.schema !== 1) fail(-1, 'schema', `schema must be 1, got ${String(manifest.schema)}`)
  if (!isNonEmptyString(manifest.revision))
    fail(-1, 'revision', 'revision must be a non-empty string')
  if (!Array.isArray(manifest.entries)) {
    fail(-1, 'entries', 'entries must be an array')
    return problems
  }

  const seen = new Map<string, number>()
  manifest.entries.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail(index, 'entry', 'entry must be an object')
      return
    }
    const entry = raw as Partial<ModelWeightEntry>

    if (!isNonEmptyString(entry.id)) fail(index, 'id', 'id must be a non-empty string')
    if (!isNonEmptyString(entry.revision))
      fail(index, 'revision', 'revision must be a non-empty string')
    else if (entry.revision.toLowerCase() === 'latest') {
      // A pinned manifest exists so a reader can reproduce bytes; `latest` cannot.
      fail(index, 'revision', 'revision must be pinned, not "latest"')
    }
    if (!isNonEmptyString(entry.publisher))
      fail(index, 'publisher', 'publisher must be a non-empty string')
    if (!isNonEmptyString(entry.url)) fail(index, 'url', 'url must be a non-empty string')
    else if (!/^https:\/\//.test(entry.url)) fail(index, 'url', 'url must be https')

    if (!isHex64(entry.sha256)) {
      // The same refusal the download primitive makes, made at build time instead of download time.
      fail(index, 'sha256', 'sha256 must be 64 lowercase hex characters')
    }
    if (!Number.isInteger(entry.bytes) || (entry.bytes as number) <= 0) {
      fail(index, 'bytes', 'bytes must be a positive integer')
    }
    if (!isNonEmptyString(entry.license)) {
      fail(index, 'license', 'license must be named; blank means we may not redistribute it')
    }
    if (typeof entry.kind !== 'string' || !KINDS.includes(entry.kind as ModelWeightKind)) {
      fail(index, 'kind', `kind must be one of ${KINDS.join(', ')}`)
    }
    if (entry.publisherMd5 !== undefined && !/^[0-9a-f]{32}$/.test(entry.publisherMd5)) {
      fail(index, 'publisherMd5', 'publisherMd5, when present, must be 32 lowercase hex characters')
    }

    if (isNonEmptyString(entry.id) && isNonEmptyString(entry.revision)) {
      const key = `${entry.id}@${entry.revision}`
      const first = seen.get(key)
      if (first !== undefined) {
        fail(index, 'id', `id@revision "${key}" already used by entry ${first}`)
      } else {
        seen.set(key, index)
      }
    }
  })

  return problems
}

/** Convenience for gates and panels: the manifest is usable only when there is nothing to report. */
export const isUsableModelWeightManifest = (value: unknown): boolean =>
  validateModelWeightManifest(value).length === 0
