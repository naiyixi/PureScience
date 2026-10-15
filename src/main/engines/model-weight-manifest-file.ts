/**
 * The *file* half of the manifest: reading it, and naming honestly why it is not usable.
 *
 * The manifest ships inside the app (offline-readable), so this runs on every start with no network in
 * the picture. Three outcomes must stay distinct, because collapsing them is exactly how a page starts
 * claiming more than it can back:
 *
 *   absent  — the manifest is not shipped yet. About us, and says so.
 *   invalid — it is there but fails validation (a publisher error we must not paper over).
 *   usable  — it validates; entries can be listed.
 *
 * Parsing is separated from reading so the rules can be tested as strings, without touching a filesystem.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  validateModelWeightManifest,
  type ModelWeightManifest,
  type ModelWeightManifestProblem
} from './model-weight-manifest'

export type ModelWeightManifestFileState =
  | { state: 'absent'; path: string }
  | {
      state: 'invalid'
      path: string
      reason: 'unreadable' | 'not-json' | 'failed-validation'
      problems: ModelWeightManifestProblem[]
    }
  | { state: 'usable'; path: string; manifest: ModelWeightManifest }

/** Parses manifest text into one of the three states. Pure: same text in, same verdict out. */
export const parseModelWeightManifestText = (
  text: string,
  path = '<memory>'
): ModelWeightManifestFileState => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON is a publisher error, not an empty listing: never present it as "no models".
    return { state: 'invalid', path, reason: 'not-json', problems: [] }
  }

  const problems = validateModelWeightManifest(parsed)
  if (problems.length > 0) return { state: 'invalid', path, reason: 'failed-validation', problems }

  return { state: 'usable', path, manifest: parsed as ModelWeightManifest }
}

/**
 * Reads the shipped manifest. A missing file is `absent` (we have not published weights yet); any other
 * read failure is reported as `unreadable` rather than silently downgraded to either of the other states.
 */
export const readModelWeightManifestFile = (path: string): ModelWeightManifestFileState => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    if (code === 'ENOENT') return { state: 'absent', path }
    return { state: 'invalid', path, reason: 'unreadable', problems: [] }
  }
  return parseModelWeightManifestText(text, path)
}

// --- where the shipped manifest lives, and what a diagnostics reader may say about it ---

/**
 * Which copy answered.
 *
 * The distinction that matters is `none` versus the rest: "no manifest exists anywhere this build can
 * look" is a fact about *us* (nothing published, or a packaging mistake), while "the manifest at a known
 * location does not validate" is a fact about the *file*. Collapsing them would make a packaging bug read
 * as "we never shipped a manifest", which is the one reading that hides what went wrong.
 */
export type ModelWeightManifestFoundSource = 'override' | 'packaged' | 'dev'
export type ModelWeightManifestSource = ModelWeightManifestFoundSource | 'none'

export type ModelWeightManifestLocation =
  | Readonly<{
      found: true
      source: ModelWeightManifestFoundSource
      path: string
      candidates: readonly string[]
    }>
  | Readonly<{ found: false; source: 'none'; candidates: readonly string[] }>

export type ModelWeightManifestLocationDeps = Readonly<{
  /** `PURESCIENCE_MODEL_WEIGHT_MANIFEST`: an explicit path wins outright (tests, trying an unpublished file). */
  override?: string | undefined
  /** `process.resourcesPath` when running under Electron: electron-builder ships the directory as `model-weights`. */
  resourcesPath?: string | undefined
  /** Directory of the module asking (callers pass `__dirname`). */
  fromDir: string
  /** Test seam; a real `existsSync` otherwise. */
  exists?: (path: string) => boolean
}>

/** Levels above the asking module the repo root can sit: `out/main`, `src/main`, `src/main/<dir>`, deeper. */
const DEV_UPWARD_DEPTHS = [1, 2, 3, 4] as const

/**
 * Finds the manifest that shipped with this build. Existence-checked, and the checked candidates are
 * returned with the answer: a resolution miss must be visible as a miss, not folded into "not published".
 * The path is deliberately *not* part of the diagnostics report below — see `describeModelWeightManifest`.
 */
export const resolveModelWeightManifestLocation = (
  deps: ModelWeightManifestLocationDeps
): ModelWeightManifestLocation => {
  const exists = deps.exists ?? existsSync
  const candidates: { path: string; source: ModelWeightManifestFoundSource }[] = []

  const override = deps.override?.trim()
  if (override) {
    // The override is the *only* candidate, not merely the first one. Falling back to another copy would let
    // a run that meant to read an unpublished manifest silently validate the shipped one instead — and the
    // answer would look the same as a success.
    const found = exists(override)
    return found
      ? { found: true, source: 'override', path: override, candidates: [override] }
      : { found: false, source: 'none', candidates: [override] }
  }
  if (deps.resourcesPath) {
    // Packaged: extraResources maps `resources/model-weights` to `model-weights` beside app.asar.
    candidates.push({
      path: join(deps.resourcesPath, 'model-weights', 'manifest.json'),
      source: 'packaged'
    })
  }
  for (const depth of DEV_UPWARD_DEPTHS) {
    candidates.push({
      path: join(
        deps.fromDir,
        ...Array.from({ length: depth }, () => '..'),
        'resources',
        'model-weights',
        'manifest.json'
      ),
      source: 'dev'
    })
  }

  const paths = candidates.map((candidate) => candidate.path)
  const hit = candidates.find((candidate) => exists(candidate.path))
  if (!hit) return { found: false, source: 'none', candidates: paths }
  return { found: true, source: hit.source, path: hit.path, candidates: paths }
}

/**
 * The manifest's state as a **pathless** reading, for surfaces that leave the machine (the support
 * bundle): a bundle must never carry absolute paths, so the one field this projection drops is the path
 * everything else was derived from.
 *
 * `entryCount` is absent — not 0 — whenever there is no trustworthy count: nothing was found, or what was
 * found failed to validate. A zero there would be a number nobody measured, on the surface a maintainer
 * reads first.
 */
export type ModelWeightManifestReport = Readonly<{
  source: ModelWeightManifestSource
  /** Whether a candidate file existed at all. `false` keeps "not shipped" apart from "shipped, unreadable". */
  present: boolean
  state: ModelWeightManifestFileState['state']
  reason?: 'unreadable' | 'not-json' | 'failed-validation'
  entryCount?: number
  problems: readonly ModelWeightManifestProblem[]
}>

export const describeModelWeightManifest = (
  location: ModelWeightManifestLocation,
  state: ModelWeightManifestFileState
): ModelWeightManifestReport => {
  if (state.state === 'usable') {
    return {
      source: location.source,
      present: location.found,
      state: 'usable',
      entryCount: state.manifest.entries.length,
      problems: []
    }
  }
  if (state.state === 'invalid') {
    return {
      source: location.source,
      present: location.found,
      state: 'invalid',
      reason: state.reason,
      problems: state.problems
    }
  }
  return { source: location.source, present: location.found, state: 'absent', problems: [] }
}

export type ShippedModelWeightManifestReading = Readonly<{
  location: ModelWeightManifestLocation
  /** Undefined exactly when no candidate existed: there is nothing to have a verdict about. */
  state?: ModelWeightManifestFileState
  report: ModelWeightManifestReport
}>

/**
 * Resolves and reads the shipped manifest in one step — the entry point a production caller uses, so the
 * path rules and the parsing rules are asked together and cannot disagree about which file is "the" one.
 */
export const readShippedModelWeightManifest = (
  deps: ModelWeightManifestLocationDeps
): ShippedModelWeightManifestReading => {
  const location = resolveModelWeightManifestLocation(deps)
  if (!location.found) {
    return { location, report: { source: 'none', present: false, state: 'absent', problems: [] } }
  }
  const state = readModelWeightManifestFile(location.path)
  return { location, state, report: describeModelWeightManifest(location, state) }
}
