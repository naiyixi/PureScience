import type { NotebookRunRiskReceipt } from '../../shared/notebook'
import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookRunRiskAssessment } from './run-risk-rules'
import { evaluateNotebookRunRisk } from './run-risk-rules'

// The shape the two consumers of a risk verdict need, and the words they show.
//
// Consumers: (1) the approval card, which has to say *which* rule fired and *which line* to look at,
// and (2) the run history, which stores the receipt so a third party can recompute it from the cell
// text. Both must read the same names — a card that said "fs-delete" while the record said "delete
// rule" would make the recomputation disagree with what the user approved.

/** The persisted shape is the shared contract type: one definition, two consumers (record + card). */
export type { NotebookRunRiskGate, NotebookRunRiskReceipt }

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

/**
 * The hash half of the receipt's recipe, for a reader that holds the cell source but no receipt (a run
 * recorded before receipts existed). Deliberately the same call the receipt itself makes rather than a
 * second sha256 in a second file: the recipe is published, so a second implementation is a second
 * recipe waiting to drift. It runs the rule scan and keeps only the hash — the assessment it returns
 * is discarded, and no receipt is written from it.
 */
export const notebookRunSourceHash = (source: string): string =>
  evaluateNotebookRunRisk(source).codeHash

/**
 * The gate a reviewed cell run resolves to. 'unreviewed' means a review was needed and no approver was
 * wired — a state the caller must make loud rather than treat as 'pass'.
 */
type NotebookRunRiskGate = 'pass' | 'allow' | 'decline' | 'unreviewed'

/**
 * Decides what a cell run does about the risk review. Kept here (pure of the kernel, taking the reviewer
 * as an argument) so both run paths and the tests share one decision, instead of each call site growing
 * its own copy of "should we ask, and what does the answer mean".
 */
export const resolveNotebookRunRiskGate = async (input: {
  code: string
  reviewer?: (input: {
    sessionId: string
    code: string
    language: NotebookLanguage
    receipt: NotebookRunRiskReceipt
  }) => Promise<boolean>
  sessionId?: string
  language?: NotebookLanguage
}): Promise<{ gate: NotebookRunRiskGate; receipt: NotebookRunRiskReceipt }> => {
  const receipt = notebookRunRiskReceipt(evaluateNotebookRunRisk(input.code))
  if (receipt.verdict !== 'review') return { gate: 'pass', receipt }
  if (!input.reviewer) return { gate: 'unreviewed', receipt }

  const approved = await input.reviewer({
    sessionId: input.sessionId ?? '',
    code: input.code,
    language: input.language ?? 'python',
    receipt
  })

  return { gate: approved ? 'allow' : 'decline', receipt }
}

/**
 * A reviewed cell the user declined: nothing ran. The rules stay machine-readable so a caller can name
 * what was refused instead of reporting a generic failure.
 */
class NotebookRunDeclinedError extends Error {
  constructor(readonly ruleIds: readonly string[]) {
    super(`Notebook run declined: ${ruleIds.join(', ')}`)
    this.name = 'NotebookRunDeclinedError'
  }
}

export { NotebookRunDeclinedError }
