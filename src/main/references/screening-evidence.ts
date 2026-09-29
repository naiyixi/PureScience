import type { Reference } from '../../shared/references'
import type { ScreeningEvidenceCoverage } from '../../shared/references-screening'
import type { ScreeningEvidenceSections } from './screening-digest'

// Evidence assembly (S2.2): turns what the library actually holds for one reference into the three
// evidence tiers the model is shown, and states how much of the record that amounts to. The tiers are
// the plan's coverage vocabulary, computed from the material rather than claimed by the caller:
//
//   full-text      a PDF attachment yielded readable body text
//   abstract-only  no readable full text, but the record carries an abstract
//   metadata-only  no full text and no abstract; only bibliographic fields are on hand
//   unavailable    nothing usable — the record is missing or carries no fields at all
//
// Coverage is advisory only in one direction: it says how much there is, never what the verdict may
// be. That decision belongs to S1's applyEvidenceCoverage (screening-freshness.ts), which this module
// deliberately does not duplicate or bypass.

// What the library offers per record. The reader resolves the attachment's managed file through the
// same PDF extractor the attachment pipeline uses; `null` means "no readable text on hand", which is
// a normal outcome for a scanned PDF or a record with no attachment, not an error.
export type ScreeningEvidenceSource = {
  reference: Reference | null
  // Body text of the newest usable PDF attachment, cited works already removed by stripCitedWorks().
  fullText?: string | null
}

export type ScreeningEvidenceBundle = {
  referenceId: string
  coverage: ScreeningEvidenceCoverage
  sections: ScreeningEvidenceSections
  // Character count of the evidence that will actually be handed to the model, which is what
  // screening-freshness.ts compares against the input budget.
  inputChars: number
  // True when a bibliography section was cut from the body text (prompt guardrail ④). Surfaced so a
  // caller can show why a cited study's content is absent rather than silently missing.
  citedWorksRemoved: boolean
}

// A line that is (only) a cited-works heading. Numbered variants ("7. References") and the CJK forms
// a Chinese-language library actually stores are included; matching is line-anchored so prose that
// merely mentions the word "references" is left alone.
const CITED_WORKS_HEADING =
  /^(?:\d+[.)]?\s*)?(references|bibliography|works cited|literature cited|references and notes|cited works|参考文献|引用文献|參考文獻)\s*[:：]?\s*$/i

// Prompt guardrail ④, enforced mechanically: the content of works a paper CITES is not this paper's
// evidence, so a trailing bibliography is trimmed before the text is ever shown to the model. A
// model that is merely told to ignore that content can be talked out of it; text that never reaches
// the prompt cannot.
export const stripCitedWorks = (text: string): { body: string; citedWorksRemoved: boolean } => {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!CITED_WORKS_HEADING.test(lines[index])) continue
    // Only a heading that follows real body text marks the bibliography: a document whose first
    // non-empty line is "References" is not one whose whole content should be thrown away.
    const bodyBefore = lines.slice(0, index).join('\n').trim()
    if (bodyBefore.length === 0) continue
    return { body: lines.slice(0, index).join('\n').trimEnd(), citedWorksRemoved: true }
  }
  return { body: text, citedWorksRemoved: false }
}

const nonEmpty = (value: string | null | undefined): string => value?.trim() ?? ''

// The bibliographic tier. Empty when the record itself is absent, so an unknown reference cannot
// masquerade as a metadata-only one.
const renderMetadataSection = (reference: Reference | null): string => {
  if (!reference) return ''
  const authors = reference.authors.map((author) => author.name).filter(Boolean)
  const fields: Array<[string, string]> = [
    ['Title', nonEmpty(reference.title)],
    ['Authors', authors.join('; ')],
    ['Venue', nonEmpty(reference.venue)],
    ['Year', reference.year === undefined ? '' : String(reference.year)],
    ['Item type', nonEmpty(reference.itemType)],
    ['DOI', nonEmpty(reference.doi)],
    ['PMID', nonEmpty(reference.pmid)],
    ['URL', nonEmpty(reference.url)],
    ['Citation key', nonEmpty(reference.citationKey)]
  ]
  return fields
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
}

const hasUsableMetadata = (reference: Reference | null): boolean =>
  renderMetadataSection(reference).length > 0

// The coverage decision, stated once. Ordered strongest-first and exhaustive: every record lands in
// exactly one tier, which is what the plan's "覆盖率清单" (S5) is checked against.
export const resolveEvidenceCoverage = (tiers: {
  hasFullText: boolean
  hasAbstract: boolean
  hasMetadata: boolean
}): ScreeningEvidenceCoverage => {
  if (tiers.hasFullText) return 'full-text'
  if (tiers.hasAbstract) return 'abstract-only'
  if (tiers.hasMetadata) return 'metadata-only'
  return 'unavailable'
}

export const assembleScreeningEvidence = (
  source: ScreeningEvidenceSource
): ScreeningEvidenceBundle => {
  const { reference } = source
  // Text with no owning record is not that record's evidence: a reference that is gone reads as
  // unavailable even if a caller hands over a passage, rather than presenting a passage nobody owns.
  const stripped = reference
    ? stripCitedWorks(source.fullText ?? '')
    : { body: '', citedWorksRemoved: false }
  const fullText = stripped.body.trim()
  const abstract = nonEmpty(reference?.abstractSnippet)
  const metadata = renderMetadataSection(reference)

  const coverage = resolveEvidenceCoverage({
    hasFullText: fullText.length > 0,
    hasAbstract: abstract.length > 0,
    hasMetadata: hasUsableMetadata(reference)
  })
  const sections: ScreeningEvidenceSections = { metadata, abstract, fullText }

  return {
    referenceId: reference?.id ?? '',
    coverage,
    sections,
    inputChars: fullText.length + abstract.length + metadata.length,
    // Only report the cut when there was body text to keep; a bibliography trimmed from an empty
    // document changed nothing.
    citedWorksRemoved: stripped.citedWorksRemoved && fullText.length > 0
  }
}
