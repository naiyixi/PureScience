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

import { readFileSync } from 'node:fs'

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
