import type { NotebookRunRiskReceipt } from '../../shared/notebook'
import type { NotebookRunRiskAssessment } from './run-risk-rules'

// The shape the two consumers of a risk verdict need, and the words they show.
//
// Consumers: (1) the approval card, which has to say *which* rule fired and *which line* to look at,
// and (2) the run history, which stores the receipt so a third party can recompute it from the cell
// text. Both must read the same names — a card that said "fs-delete" while the record said "delete
// rule" would make the recomputation disagree with what the user approved.

/** The persisted shape is the shared contract type: one definition, two consumers (record + card). */
export type { NotebookRunRiskReceipt }

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
