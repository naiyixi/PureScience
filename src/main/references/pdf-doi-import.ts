import { extractDois } from '../../shared/doi-extraction'
import type { CreateReferenceInput } from '../../shared/references'

// Importing the references a PDF cites: read the identifier off the page, resolve it through the same
// public-API path the library's add-by-identifier uses, and write through the same add call — so an
// imported reference is indistinguishable from one the reader typed, including its duplicate handling.
//
// Two rules keep an import honest:
//   * the number of identifiers resolved per document is capped, and what the cap left behind is
//     reported (`truncated`) rather than silently dropped;
//   * every identifier that cannot be resolved is listed by name with why. A PDF that yields three
//     resolvable DOIs and one dead one produces three references and one named failure — never a
//     reference invented to make the count look right.
export const MAX_DOIS_PER_IMPORT = 5

export type PdfDoiImportOutcome =
  | { doi: string; status: 'created'; referenceId: string }
  | { doi: string; status: 'duplicate'; referenceId: string }
  | { doi: string; status: 'failed'; reason: string }

export type PdfDoiImportResult = {
  outcomes: readonly PdfDoiImportOutcome[]
  created: number
  duplicates: number
  failed: number
  /** Identifiers found beyond the per-document cap; they were not resolved. */
  truncated: number
}

export type PdfDoiImportPorts = {
  /** Reads the text of the pages worth scanning, in order. */
  readText: (limit: number) => Promise<string>
  /** Resolves an identifier to the fields a reference needs, or undefined when nothing matched. */
  resolve: (doi: string) => Promise<CreateReferenceInput | undefined>
  /** Writes a reference; `duplicate` is a normal outcome, not an error. */
  add: (
    input: CreateReferenceInput
  ) => Promise<{ status: 'created' | 'duplicate'; referenceId: string }>
}

export const importReferencesFromPdfText = async (
  ports: PdfDoiImportPorts,
  options: { limit?: number } = {}
): Promise<PdfDoiImportResult> => {
  const limit = options.limit ?? MAX_DOIS_PER_IMPORT
  const text = await ports.readText(limit)
  const found = extractDois(text)
  const selected = found.slice(0, limit)
  const outcomes: PdfDoiImportOutcome[] = []

  for (const doi of selected) {
    let input: CreateReferenceInput | undefined
    try {
      input = await ports.resolve(doi)
    } catch (error) {
      outcomes.push({
        doi,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    if (!input) {
      outcomes.push({ doi, status: 'failed', reason: 'no metadata found for this DOI' })
      continue
    }
    try {
      const added = await ports.add(input)
      outcomes.push({ doi, status: added.status, referenceId: added.referenceId })
    } catch (error) {
      outcomes.push({
        doi,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return {
    outcomes,
    created: outcomes.filter((outcome) => outcome.status === 'created').length,
    duplicates: outcomes.filter((outcome) => outcome.status === 'duplicate').length,
    failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
    truncated: Math.max(0, found.length - selected.length)
  }
}
