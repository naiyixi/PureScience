import type { Translate } from '@/i18n'
import type { NotebookRunRiskReceipt, NotebookRunRiskRuleId } from '../../../shared/notebook'

// The one place the risk verdict becomes words. The main process hands over DATA (the receipt: which
// rules fired, on which lines, with the hash), so the copy lives here where nine languages exist —
// a sentence composed in main could only ever be English (see the reverse rule in the i18n playbook).
//
// The machine rule id stays visible beside its translated name on purpose: the receipt a third party
// recomputes names `fs-delete`, so the card that asks for approval has to name the same thing.

const RULE_NAME_KEYS: Record<NotebookRunRiskRuleId, string> = {
  'fs-delete': 'notebookRisk.ruleFsDelete',
  'fs-overwrite': 'notebookRisk.ruleFsOverwrite',
  'shell-exec': 'notebookRisk.ruleShellExec',
  'large-allocation': 'notebookRisk.ruleLargeAllocation'
}

const translateKey = (t: Translate, key: string): string => (t as (key: string) => string)(key)

const ruleName = (t: Translate, ruleId: NotebookRunRiskRuleId): string =>
  translateKey(t, RULE_NAME_KEYS[ruleId])

const whereText = (t: Translate, lines: readonly number[]): string =>
  translateKey(t, lines.length === 1 ? 'notebookRisk.oneLine' : 'notebookRisk.manyLines').replace(
    '{numbers}',
    lines.join(', ')
  )

/** The card's title. Undefined when nothing fired — an allow has no sentence to show. */
export const notebookRiskTitle = (
  t: Translate,
  receipt: NotebookRunRiskReceipt
): string | undefined => {
  if (receipt.verdict === 'allow' || receipt.hits.length === 0) return undefined

  const first = receipt.hits[0]
  if (receipt.hits.length === 1) {
    return translateKey(t, 'notebookRisk.titleOne')
      .replace('{rule}', ruleName(t, first.ruleId))
      .replace('{where}', whereText(t, first.lines))
  }
  const names = receipt.hits.map((hit) => ruleName(t, hit.ruleId)).join(', ')
  return translateKey(t, 'notebookRisk.titleMany')
    .replace('{count}', String(receipt.hits.length))
    .replace('{rules}', names)
}

/** One line per fired rule: its name, the id the receipt uses, where it fired, and the code to read. */
export const notebookRiskLines = (t: Translate, receipt: NotebookRunRiskReceipt): string[] =>
  receipt.hits.map((hit) =>
    translateKey(t, 'notebookRisk.line')
      .replace('{rule}', ruleName(t, hit.ruleId))
      .replace('{ruleId}', hit.ruleId)
      .replace('{where}', whereText(t, hit.lines))
      .replace('{excerpts}', hit.excerpts.join(' | '))
  )
