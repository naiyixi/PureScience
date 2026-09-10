// Task checkpoint contract (v1.53): a project-scoped, auditable snapshot of task progress so a
// long multi-step run can resume from verified work instead of re-discovering it. Distinct from
// session resume (turn-level, conversation continuity): this is the *task node* layer — verified
// identifiers, installed packages, and computed outputs with their sources.
//
// Guardrail G4: every checkpoint carries a schema version and the fingerprint of the inputs it
// was computed from. When the inputs change, the checkpoint is reported `stale` and its contents
// must be re-verified rather than trusted — an old result must never masquerade as fresh.

export const TASK_CHECKPOINT_SCHEMA_VERSION = 1

export const TASK_CHECKPOINT_FILE_NAME = 'task-checkpoint.json'

export type CheckpointFact = {
  /** Stable identity, e.g. "uniprot:SHANK2" or "gene:SHANK2". */
  key: string
  value: string
  /** Where the value came from, e.g. "uniprot.org" or "connector:uniprot". */
  source: string
  verifiedAt?: string
}

export type CheckpointPackage = {
  name: string
  version?: string
  manager: 'python' | 'r' | 'other'
  installedAt?: string
}

export type CheckpointOutput = {
  /** Human-readable label, e.g. "DEG list (treated vs control)". */
  label: string
  /** Project-relative or absolute path when the output is a file artifact. */
  path?: string
  summary?: string
  computedAt?: string
}

export type TaskCheckpoint = {
  schemaVersion: number
  projectId: string
  updatedAt: string
  sessionId?: string
  /** Fingerprint of the inputs this checkpoint was computed from (see fingerprintInputs). */
  inputFingerprint: string
  activeStep?: string
  verifiedFacts: CheckpointFact[]
  installedPackages: CheckpointPackage[]
  computedOutputs: CheckpointOutput[]
  notes: string[]
}

export type CheckpointFreshness = { status: 'fresh' } | { status: 'stale'; reason: string }

const MAX_FACTS = 500
const MAX_PACKAGES = 500
const MAX_OUTPUTS = 200
const MAX_NOTES = 200
const MAX_FIELD = 2000

// Order- and case-insensitive 32-bit FNV-1a over the trimmed input strings: changing any input
// (new dataset, new version) flips the fingerprint so stale checkpoints are detectable.
export const fingerprintInputs = (inputs: readonly string[]): string => {
  const normalized = inputs
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
    .sort()
    .join('\u0000')
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`
}

const clip = (value: string): string => value.slice(0, MAX_FIELD)

export const isTaskCheckpoint = (value: unknown): value is TaskCheckpoint => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<TaskCheckpoint>
  return (
    candidate.schemaVersion === TASK_CHECKPOINT_SCHEMA_VERSION &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    typeof candidate.inputFingerprint === 'string' &&
    Array.isArray(candidate.verifiedFacts) &&
    Array.isArray(candidate.installedPackages) &&
    Array.isArray(candidate.computedOutputs) &&
    Array.isArray(candidate.notes)
  )
}

export type TaskCheckpointPatch = {
  sessionId?: string
  inputFingerprint?: string
  activeStep?: string
  verifiedFacts?: CheckpointFact[]
  installedPackages?: CheckpointPackage[]
  computedOutputs?: CheckpointOutput[]
  notes?: string[]
}

const normalizeFacts = (facts: readonly CheckpointFact[]): CheckpointFact[] => {
  const byKey = new Map<string, CheckpointFact>()
  for (const fact of facts) {
    const key = fact.key.trim()
    const value = fact.value.trim()
    if (!key || !value) continue
    byKey.set(key.toLowerCase(), {
      key: clip(key),
      value: clip(value),
      source: clip(fact.source?.trim() ?? 'unspecified'),
      verifiedAt: fact.verifiedAt
    })
  }
  return [...byKey.values()].slice(0, MAX_FACTS)
}

const normalizePackages = (packages: readonly CheckpointPackage[]): CheckpointPackage[] => {
  const byName = new Map<string, CheckpointPackage>()
  for (const entry of packages) {
    const name = entry.name.trim()
    if (!name) continue
    byName.set(`${entry.manager}:${name.toLowerCase()}`, {
      name: clip(name),
      version: entry.version ? clip(entry.version.trim()) : undefined,
      manager: entry.manager,
      installedAt: entry.installedAt
    })
  }
  return [...byName.values()].slice(0, MAX_PACKAGES)
}

const normalizeOutputs = (outputs: readonly CheckpointOutput[]): CheckpointOutput[] => {
  const byLabel = new Map<string, CheckpointOutput>()
  for (const output of outputs) {
    const label = output.label.trim()
    if (!label) continue
    byLabel.set(label.toLowerCase(), {
      label: clip(label),
      path: output.path ? clip(output.path.trim()) : undefined,
      summary: output.summary ? clip(output.summary.trim()) : undefined,
      computedAt: output.computedAt
    })
  }
  return [...byLabel.values()].slice(0, MAX_OUTPUTS)
}

export const emptyTaskCheckpoint = (projectId: string, now: string): TaskCheckpoint => ({
  schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION,
  projectId,
  updatedAt: now,
  inputFingerprint: '',
  verifiedFacts: [],
  installedPackages: [],
  computedOutputs: [],
  notes: []
})

// Section-aware merge: patch entries replace same-identity base entries, everything else is kept.
export const mergeTaskCheckpoint = (
  base: TaskCheckpoint,
  patch: TaskCheckpointPatch,
  now: string
): TaskCheckpoint => {
  const mergedFacts = normalizeFacts([...base.verifiedFacts, ...(patch.verifiedFacts ?? [])])
  const mergedPackages = normalizePackages([
    ...base.installedPackages,
    ...(patch.installedPackages ?? [])
  ])
  const mergedOutputs = normalizeOutputs([
    ...base.computedOutputs,
    ...(patch.computedOutputs ?? [])
  ])
  const notes = [...base.notes, ...(patch.notes ?? [])]
    .map((note) => clip(note.trim()))
    .filter((note) => note.length > 0)
    .slice(-MAX_NOTES)

  return {
    schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION,
    projectId: base.projectId,
    updatedAt: now,
    sessionId: patch.sessionId ?? base.sessionId,
    inputFingerprint: patch.inputFingerprint ?? base.inputFingerprint,
    activeStep: patch.activeStep ?? base.activeStep,
    verifiedFacts: mergedFacts,
    installedPackages: mergedPackages,
    computedOutputs: mergedOutputs,
    notes
  }
}

// G4 gate: a checkpoint is only 'fresh' when it was computed from exactly these inputs.
export const evaluateCheckpointFreshness = (
  checkpoint: Pick<TaskCheckpoint, 'inputFingerprint'>,
  currentFingerprint: string
): CheckpointFreshness => {
  if (!checkpoint.inputFingerprint) {
    return {
      status: 'stale',
      reason: 'Checkpoint has no input fingerprint; re-verify its contents.'
    }
  }
  if (checkpoint.inputFingerprint !== currentFingerprint) {
    return {
      status: 'stale',
      reason: `Inputs changed (checkpoint ${checkpoint.inputFingerprint} vs current ${currentFingerprint}); re-verify before reusing these results.`
    }
  }
  return { status: 'fresh' }
}
