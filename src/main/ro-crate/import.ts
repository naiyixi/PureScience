import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  validateRoCrate,
  type RoCrateMetadataDocument,
  type RoCrateValidationReport
} from '../../shared/ro-crate'

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
export const EXTERNAL_RO_CRATE_REFUSALS = ['no-metadata-file', 'unreadable', 'unparseable'] as const

export type ExternalRoCrateRefusal = (typeof EXTERNAL_RO_CRATE_REFUSALS)[number]

export const RO_CRATE_METADATA_FILENAME = 'ro-crate-metadata.json'

export type ExternalRoCrateInspection =
  | { ok: true; metadataPath: string; report: RoCrateValidationReport }
  | { ok: false; reason: ExternalRoCrateRefusal; detail: string }

const describe = (error: unknown): string => String((error as Error)?.message ?? error)

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

  return { ok: true, metadataPath, report: validateRoCrate({ document }) }
}
