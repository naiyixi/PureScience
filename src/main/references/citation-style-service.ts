import { createHash } from 'node:crypto'

import {
  importCslStyle,
  type CslImportOutcome,
  type ImportedCitationStyle
} from '../../shared/citation/csl'
import { BUILTIN_CITATION_STYLES } from '../../shared/citation/builtin-styles'
import type { CitationStyleRepository } from './citation-style-repository'

// Owns citation-style imports (v1.65). The document is parsed and validated by the shared layer; this
// service supplies the pieces that belong to the main process — the SHA-256 of the imported bytes,
// the set of built-in ids an import may not shadow — and stores the accepted style.
export type CitationStyleImportResult =
  | { status: 'imported'; style: ImportedCitationStyle; replacedExisting: boolean }
  | { status: 'rejected'; reason: string; detail?: string }

export const citationStyleDocumentHash = (xml: string): string =>
  `sha256:${createHash('sha256').update(xml, 'utf8').digest('hex')}`

export const MAX_CITATION_STYLE_BYTES = 2 * 1024 * 1024

export class CitationStyleService {
  constructor(private readonly repository: CitationStyleRepository) {}

  async listStyles(): Promise<ImportedCitationStyle[]> {
    return this.repository.listStyles()
  }

  // Imports one style document. A rejection carries the shared layer's named reason, so the UI can
  // explain exactly what was wrong instead of showing a generic failure.
  async importStyle(input: { fileName: string; xml: string }): Promise<CitationStyleImportResult> {
    if (Buffer.byteLength(input.xml, 'utf8') > MAX_CITATION_STYLE_BYTES) {
      return { status: 'rejected', reason: 'too-large' }
    }
    const existing = await this.repository.listStyles()
    const outcome: CslImportOutcome = importCslStyle(input.xml, input.fileName, {
      hash: citationStyleDocumentHash,
      builtinStyleIds: BUILTIN_CITATION_STYLES.map((style) => style.id),
      importedAt: Date.now()
    })
    if (outcome.status === 'rejected') {
      return { status: 'rejected', reason: outcome.reason, detail: outcome.detail }
    }
    const replacedExisting = existing.some((style) => style.id === outcome.style.id)
    const stored = await this.repository.saveStyle(outcome.style)
    return { status: 'imported', style: stored, replacedExisting }
  }

  async removeStyle(styleId: string): Promise<void> {
    await this.repository.removeStyle(styleId)
  }
}
