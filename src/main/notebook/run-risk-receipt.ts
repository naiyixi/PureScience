import type { NotebookRunRiskAssessment, RunRiskRuleId } from './run-risk-rules'

// The shape the two consumers of a risk verdict need, and the words they show.
//
// Consumers: (1) the approval card, which has to say *which* rule fired and *which line* to look at,
// and (2) the run history, which stores the receipt so a third party can recompute it from the cell
// text. Both must read the same names — a card that said "fs-delete" while the record said "delete
// rule" would make the recomputation disagree with what the user approved.

/** What the run record stores. Deliberately plain data: no undefined, no class, JSON-serializable. */
export type NotebookRunRiskReceipt = {
  verdict: 'allow' | 'review'
  ruleSetVersion: string
  codeHash: string
  hits: Array<{
    ruleId: RunRiskRuleId
    ruleVersion: string
    lines: number[]
    excerpts: string[]
  }>
}

/** A copy, so a later mutation of the assessment cannot rewrite what was recorded. */
export const notebookRunRiskReceipt = (
  assessment: NotebookRunRiskAssessment
): NotebookRunRiskReceipt => ({
  verdict: assessment.verdict,
  ruleSetVersion: assessment.ruleSetVersion,
  codeHash: assessment.codeHash,
  hits: assessment.hits.map((hit) => ({
    ruleId: hit.ruleId,
    ruleVersion: hit.ruleVersion,
    lines: [...hit.lines],
    excerpts: [...hit.excerpts]
  }))
})

const describeLines = (lines: readonly number[]): string =>
  lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(', ')}`

/**
 * One line per fired rule: the rule's own name and version, where it fired, and the code to read.
 * Nothing here summarises — a reviewer re-reads the rule name and the excerpt, and a bare "this looks
 * risky" is exactly the form this exists to replace.
 */
export const runRiskReceiptLines = (assessment: NotebookRunRiskAssessment): string[] =>
  assessment.hits.map(
    (hit) =>
      `${hit.ruleId} (${hit.ruleVersion}) — ${describeLines(hit.lines)}: ${hit.excerpts.join(' | ')}`
  )

/**
 * The card's title. Undefined when nothing fired: an allow carries no sentence to show, rather than a
 * reassuring one that would teach the reader to skip the card.
 */
export const notebookRunRiskApprovalTitle = (
  assessment: NotebookRunRiskAssessment
): string | undefined => {
  if (assessment.verdict === 'allow') return undefined

  const first = assessment.hits[0]
  const where = describeLines(first.lines)
  if (assessment.hits.length === 1) {
    return `Review this notebook run: ${first.ruleId} fired at ${where}`
  }
  const names = assessment.hits.map((hit) => hit.ruleId).join(', ')
  return `Review this notebook run: ${assessment.hits.length} rules fired (${names})`
}
