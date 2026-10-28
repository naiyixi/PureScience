import {
  REFERENCE_INTEGRITY_GAP_REASONS,
  type ReferenceIntegrityGap,
  type ReferenceIntegrityGapReason,
  type ReferenceIntegrityRetraction,
  type ReferenceIntegritySummary
} from '../../../../shared/references-integrity'

// The citation-integrity half of a triage export (B1 导出闸门): the step between "these records are in
// the bibliography" and "each of them has a stored verdict about being retracted or corrected".
//
// Three decisions are the whole module:
//
//   1. the gate READS STORED VERDICTS ONLY. The check that goes out to Crossref is a separate, deliberate
//      action; making an export re-check would turn one click into tens of round trips and would let a
//      rate-limited service decide whether a bibliography can be written today.
//   2. `retracted` inside the range is a DECISION, not a note: the export is refused and the records are
//      named. The three `gaps` are INSTRUCTIONS: the export proceeds, and the file states what is still
//      unknown about which record — the three reasons ask for different actions, so they are never
//      collapsed into one line.
//   3. `unavailable` is never read as `clean`. A record nobody checked, or whose check could not reach
//      Crossref, is a gap; only a stored clean verdict is not.

export type ScreeningExportIntegrityLabels = {
  header: string
  scope: string
  counts: (counts: { checked: number; total: number; gaps: number }) => string
  none: string
  gapHeader: string
  gapLine: (entry: { citationKey: string; doi: string; reasonLabel: string }) => string
  reasonLabels: Record<ReferenceIntegrityGapReason, string>
}

export type ScreeningExportIntegrityBlock = {
  /** Retracted records that fall inside the export range: the export is refused while any is here. */
  held: readonly ReferenceIntegrityRetraction[]
  /** The block appended to the file: always written, so a file silent about integrity cannot exist. */
  block: string
}

const isReason = (value: string): value is ReferenceIntegrityGapReason =>
  (REFERENCE_INTEGRITY_GAP_REASONS as readonly string[]).includes(value)

/**
 * The export gate's text, plus the records that hold the export back.
 *
 * `includedReferenceIds` is the range being written — the same list the bibliography is numbered from.
 * A verdict about a record OUTSIDE that range is not this file's business: what the file claims is about
 * what it contains, and a gap for a record it does not name would be an instruction nobody can act on.
 */
export const buildScreeningExportIntegrityBlock = ({
  summary,
  includedReferenceIds,
  labels
}: {
  summary: ReferenceIntegritySummary
  includedReferenceIds: readonly string[]
  labels: ScreeningExportIntegrityLabels
}): ScreeningExportIntegrityBlock => {
  const position = new Map(includedReferenceIds.map((id, index) => [id, index]))
  const inRange = <T extends { referenceId: string }>(entries: readonly T[]): T[] =>
    entries
      .filter((entry) => position.has(entry.referenceId))
      .slice()
      .sort(
        (left, right) =>
          (position.get(left.referenceId) ?? 0) - (position.get(right.referenceId) ?? 0)
      )

  const held = inRange(summary.retracted)
  const gaps: readonly ReferenceIntegrityGap[] = inRange(summary.gaps)
  // An unknown reason is not dropped: the record still carries a DOI whose verdict is not a clean one, so
  // it is reported under the vocabulary's least-assuming label rather than silently disappearing.
  const reasonLabel = (reason: string): string =>
    labels.reasonLabels[isReason(reason) ? reason : 'never-checked']

  const lines = [
    `${labels.header}: ${labels.scope}`,
    labels.counts({ checked: summary.checked, total: summary.total, gaps: gaps.length })
  ]
  if (gaps.length === 0) {
    lines.push(labels.none)
  } else {
    lines.push(`${labels.gapHeader}: ${gaps.length}`)
    for (const gap of gaps) {
      lines.push(
        `  ${labels.gapLine({
          citationKey: gap.citationKey,
          doi: gap.doi,
          reasonLabel: reasonLabel(gap.reason)
        })}`
      )
    }
  }

  return { held, block: lines.join('\n') }
}
