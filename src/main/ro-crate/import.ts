import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import {
  RO_CRATE_CONTENT_DIRECTORY,
  RO_CRATE_METADATA_FILENAME,
  validateRoCrate,
  type RoCrateMetadataDocument,
  type RoCratePayloadDigest
} from '../../shared/ro-crate'
import type { ExternalRoCrateInspection } from '../../shared/ro-crate-inspect'
import { digestOfFile } from './digest'

// Reading a crate this app did not write — IC48's other half, granted read-only.
//
// It only READS: an external crate is input, so nothing here writes into it, imports it into a project, or
// rewrites it. And what comes back is what the app's own rules can see: `report.ok` means every assertion the
// app knows how to make passed — NOT that the crate is scientifically right. The surface says that where the
// report is shown; this module must not be read as certifying anything.
//
// Refusals are codes (the reader's interface language is the renderer's business) and they separate the three
// ways a path fails BEFORE any rule is judged: no metadata document, an unreadable one, an unparseable one. A
// crate whose JSON-LD parses but breaks the rules comes back as a REPORT with `ok: false` inside — that is
// exactly what the report is for, and collapsing it into a refusal would hide which rules failed.
//
// The reader passes the same two payload inputs the writer passes, so it is judged on the SAME assertions:
// what the crate really holds under its payload folder (`payloadPaths`) and the bytes recounted from disk
// (`payloadDigests`). Reading a document without them would leave three rules with nothing to judge and let
// the panel claim "every check passed" over a crate whose payloads it never looked at.
//
// The codes and the inspection shape live in `shared/ro-crate-inspect.ts` because they cross the process
// boundary: the window and this reader must be reading one list, not two copies that can drift apart.
const describe = (error: unknown): string => String((error as Error)?.message ?? error)

const contentRootOf = (cratePath: string): string => join(cratePath, RO_CRATE_CONTENT_DIRECTORY)

/** Crate-relative ids of the files the crate actually holds under its payload folder. */
const listPayloadPaths = async (contentRoot: string): Promise<string[]> => {
  const found: string[] = []
  const walk = async (relative: string): Promise<void> => {
    // An absent or unreadable payload folder is an empty one on purpose: the rules then say what is missing
    // instead of this helper turning a crate into a refusal.
    const entries = await readdir(join(contentRoot, relative), { withFileTypes: true }).catch(
      () => []
    )
    for (const entry of entries) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(next)
      // Files only, and one level of intent: a symlink is neither listed nor followed, because following
      // one would read bytes that do not belong to this crate.
      else if (entry.isFile()) found.push(`${RO_CRATE_CONTENT_DIRECTORY}/${next}`)
    }
  }
  await walk('')
  return found.sort()
}

/** The payload ids the document claims — the only files worth hashing. */
const declaredPayloadIds = (document: RoCrateMetadataDocument): string[] =>
  (document['@graph'] ?? [])
    .map((entity) => entity['@id'])
    .filter(
      (id): id is string =>
        typeof id === 'string' && id.startsWith(`${RO_CRATE_CONTENT_DIRECTORY}/`)
    )

/**
 * Whether a declared id stays inside the payload folder. A document can name any path it likes, and a reader
 * that followed one would read bytes outside the crate it was pointed at — the opposite of the read-only
 * promise. Anything that escapes (absolute, `..`, another drive) is left to the rules, which name it.
 */
const insideContentRoot = (cratePath: string, id: string): boolean =>
  resolve(cratePath, id).startsWith(`${resolve(contentRootOf(cratePath))}${sep}`)

export const inspectExternalRoCrate = async (
  cratePath: string
): Promise<ExternalRoCrateInspection> => {
  const metadataPath = join(cratePath, RO_CRATE_METADATA_FILENAME)

  let text: string
  try {
    text = await readFile(metadataPath, 'utf8')
  } catch (error) {
    // The two failures are kept apart on purpose: "this is not a crate" and "this crate cannot be read
    // right now" call for different next steps from the reader.
    return (error as { code?: string }).code === 'ENOENT'
      ? { ok: false, reason: 'no-metadata-file', detail: `${metadataPath} does not exist` }
      : { ok: false, reason: 'unreadable', detail: `${metadataPath}: ${describe(error)}` }
  }

  let document: RoCrateMetadataDocument
  try {
    document = JSON.parse(text) as RoCrateMetadataDocument
  } catch (error) {
    return { ok: false, reason: 'unparseable', detail: `${metadataPath}: ${describe(error)}` }
  }

  const payloadPaths = await listPayloadPaths(contentRootOf(cratePath))

  // Recounted from the bytes on disk, never from the hash the document claims for itself. A declared payload
  // that is absent, a directory, a symlink, or unreadable simply has no digest here — and every one of those
  // is a failed check the report names, rather than a file quietly left out of the judgement.
  const payloadDigests = new Map<string, RoCratePayloadDigest>()
  for (const id of declaredPayloadIds(document)) {
    if (!insideContentRoot(cratePath, id)) continue
    if (!payloadPaths.includes(id)) continue
    const digest = await digestOfFile(join(cratePath, id))
    if (digest !== undefined) payloadDigests.set(id, digest)
  }

  return {
    ok: true,
    metadataPath,
    report: validateRoCrate({ document, payloadPaths, payloadDigests })
  }
}
