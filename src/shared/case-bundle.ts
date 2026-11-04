// A case bundle is what one reader hands to another: the case's name, the standing its files earn, and the
// files themselves as a manifest of names, kinds, sizes and checksums. This module is the *format* only — it
// builds and validates the document, and refuses the same things a careful reader would refuse (a nameless
// case, a file list that is not a list, a bundle from a future version).
//
// The rule this module exists to enforce: **a bundle never claims a file it does not carry**. The manifest
// records each file's checksum, so the importing side can verify the bytes it received rather than trusting
// the name; and a bundle whose manifest and payload disagree is rejected whole, not partially imported.

export const CASE_BUNDLE_FORMAT = 'purescience.case-bundle'
export const CASE_BUNDLE_VERSION = 1
// A case that hands over hundreds of outputs is not something a person re-runs; the limit keeps a malformed or
// hostile bundle from being accepted as a legitimate one.
export const CASE_BUNDLE_FILE_LIMIT = 500

export type CaseBundleFile = {
  name: string
  kind: string
  sizeBytes: number
  // SHA-256 of the file's bytes, lowercase hex. Optional only because a caller may be describing a case whose
  // files it has not read yet; an importer must refuse those.
  sha256?: string
}

export type CaseBundleManifest = {
  format: typeof CASE_BUNDLE_FORMAT
  version: number
  name: string
  summary?: string
  domain: string
  createdAt: number
  files: CaseBundleFile[]
}

export type BuildCaseBundleInput = {
  name: string
  summary?: string
  domain: string
  createdAt?: number
  files: ReadonlyArray<CaseBundleFile>
}

export type CaseBundleProblem =
  | 'not-an-object'
  | 'unknown-format'
  | 'unsupported-version'
  | 'missing-name'
  | 'no-files'
  | 'too-many-files'
  | 'bad-file-entry'
  | 'duplicate-file-name'

export type CaseBundleCheck =
  | { ok: true; manifest: CaseBundleManifest }
  | { ok: false; problem: CaseBundleProblem; detail?: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normaliseFile = (entry: unknown): CaseBundleFile | undefined => {
  if (!isRecord(entry)) return undefined
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name === '') return undefined
  if (
    typeof entry.sizeBytes !== 'number' ||
    !Number.isFinite(entry.sizeBytes) ||
    entry.sizeBytes < 0
  ) {
    return undefined
  }
  const kind =
    typeof entry.kind === 'string' && entry.kind.trim() !== '' ? entry.kind.trim() : 'file'
  const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : undefined
  return {
    name,
    kind,
    sizeBytes: Math.floor(entry.sizeBytes),
    ...(sha256 ? { sha256 } : {})
  }
}

// Dupes are rejected rather than merged: two different files claiming one name is exactly the ambiguity an
// importer cannot resolve without guessing which bytes the manifest meant.
const dedupe = (
  files: ReadonlyArray<CaseBundleFile>
): { files: CaseBundleFile[]; duplicate?: string } => {
  const byName = new Map<string, CaseBundleFile>()
  for (const file of files) {
    if (byName.has(file.name.toLowerCase())) return { files: [], duplicate: file.name }
    byName.set(file.name.toLowerCase(), file)
  }
  // Stable, locale-independent order: a bundle should diff cleanly between two exports of the same case.
  const sorted = [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : 1))
  return { files: sorted }
}

export const buildCaseBundle = (
  input: BuildCaseBundleInput
): { ok: true; manifest: CaseBundleManifest } | { ok: false; problem: CaseBundleProblem } => {
  const name = input.name.trim()
  if (name === '') return { ok: false, problem: 'missing-name' }
  if (input.files.length === 0) return { ok: false, problem: 'no-files' }
  if (input.files.length > CASE_BUNDLE_FILE_LIMIT) return { ok: false, problem: 'too-many-files' }
  // Every entry goes through the same normalisation the validator uses, so a bundle this module builds is
  // always a bundle it would accept back: lowercase checksums, no stray fields, no negative sizes.
  const normalised: CaseBundleFile[] = []
  for (const entry of input.files) {
    const file = normaliseFile(entry)
    if (!file) return { ok: false, problem: 'bad-file-entry' }
    normalised.push(file)
  }
  const { files, duplicate } = dedupe(normalised)
  if (duplicate) return { ok: false, problem: 'duplicate-file-name' }
  return {
    ok: true,
    manifest: {
      format: CASE_BUNDLE_FORMAT,
      version: CASE_BUNDLE_VERSION,
      name,
      ...(input.summary && input.summary.trim() !== '' ? { summary: input.summary.trim() } : {}),
      domain: input.domain,
      createdAt: input.createdAt ?? Date.now(),
      files
    }
  }
}

// Validation is deliberately total: every rejection names its reason, so the importing window can say what is
// wrong with the file the reader picked instead of "import failed".
export const validateCaseBundle = (value: unknown): CaseBundleCheck => {
  if (!isRecord(value)) return { ok: false, problem: 'not-an-object' }
  if (value.format !== CASE_BUNDLE_FORMAT) return { ok: false, problem: 'unknown-format' }
  if (value.version !== CASE_BUNDLE_VERSION) {
    return {
      ok: false,
      problem: 'unsupported-version',
      detail: String(value.version ?? 'missing')
    }
  }
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (name === '') return { ok: false, problem: 'missing-name' }
  if (!Array.isArray(value.files)) return { ok: false, problem: 'bad-file-entry', detail: 'files' }
  if (value.files.length === 0) return { ok: false, problem: 'no-files' }
  if (value.files.length > CASE_BUNDLE_FILE_LIMIT) return { ok: false, problem: 'too-many-files' }

  const files: CaseBundleFile[] = []
  for (const entry of value.files) {
    const file = normaliseFile(entry)
    if (!file) return { ok: false, problem: 'bad-file-entry' }
    files.push(file)
  }
  const { files: deduped, duplicate } = dedupe(files)
  if (duplicate) return { ok: false, problem: 'duplicate-file-name', detail: duplicate }

  return {
    ok: true,
    manifest: {
      format: CASE_BUNDLE_FORMAT,
      version: CASE_BUNDLE_VERSION,
      name,
      ...(typeof value.summary === 'string' && value.summary.trim() !== ''
        ? { summary: value.summary.trim() }
        : {}),
      domain:
        typeof value.domain === 'string' && value.domain.trim() !== '' ? value.domain : 'general',
      createdAt:
        typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
          ? value.createdAt
          : Date.now(),
      files: deduped
    }
  }
}

// The importer's second question: the bytes it actually received against what the manifest promised. Files the
// bundle carries but the manifest does not describe are reported too — silently ignoring them would let a
// bundle smuggle content into a case.
export type CaseBundleReconciliation = {
  matched: string[]
  missing: string[]
  checksumMismatch: string[]
  unexpected: string[]
}

export const reconcileCaseBundle = (
  manifest: CaseBundleManifest,
  present: ReadonlyArray<{ name: string; sha256?: string }>
): CaseBundleReconciliation => {
  const presentByName = new Map(present.map((entry) => [entry.name, entry]))
  const matched: string[] = []
  const missing: string[] = []
  const checksumMismatch: string[] = []
  for (const file of manifest.files) {
    const actual = presentByName.get(file.name)
    if (!actual) {
      missing.push(file.name)
      continue
    }
    if (file.sha256 && actual.sha256 && file.sha256 !== actual.sha256.toLowerCase()) {
      checksumMismatch.push(file.name)
      continue
    }
    matched.push(file.name)
  }
  const described = new Set(manifest.files.map((file) => file.name))
  const unexpected = present
    .filter((entry) => !described.has(entry.name))
    .map((entry) => entry.name)
  return { matched, missing, checksumMismatch, unexpected }
}

export const caseBundleIsComplete = (reconciliation: CaseBundleReconciliation): boolean =>
  reconciliation.missing.length === 0 &&
  reconciliation.checksumMismatch.length === 0 &&
  reconciliation.unexpected.length === 0
