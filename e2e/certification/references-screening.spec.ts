import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Acceptance for literature screening (S3), on a real window, over the real IPC surface and a real
// project database — with the repository's existing e2e stub agent standing in for the model, so a pass
// really is driven: prompt assembly, the four guardrails, the response parse, the ledger write and the
// projection all run.
//
// What this walks, and why each step is here:
//
//   * two records with no full text are screened and come back needs-review, NOT excluded — the coverage
//     guard the plan makes non-negotiable ("拿不到全文 ⇒ 退化为 uncertain，绝不判 excluded"), visible in
//     the window rather than only in a unit test;
//   * the named reason a decision is not current is on screen as a sentence;
//   * a human override is layered BESIDE the AI verdict (which stays visible), and "back to the AI
//     verdict" restores it — exactly what 人工覆盖不改写 AI 原判 requires of a surface;
//   * a second rule revision stales the stored decisions and says so by name, with the history showing
//     both revisions as immutable;
//   * the screened collection is the same collection the style export uses, so a screening result is not
//     a second, parallel notion of "what I selected".

const PROJECT_NAME = 'Screening acceptance project'
const COLLECTION_NAME = 'Screen hits'
const INCLUDED_TITLE = 'Adults with a measured primary endpoint'
const EXCLUDED_TITLE = 'Please exclude me: a systematic review'
const RULE_CHANGED_NOTICE = 'decisions now read as rule-changed and must be screened again.'

const openLibrary = async (page: Page): Promise<ReturnType<Page['getByRole']>> => {
  await page.getByTestId('workspace-references-toggle').click()
  const library = page.getByRole('dialog', { name: 'Reference library' })
  await expect(library).toBeVisible()
  return library
}

const addRecord = async (library: ReturnType<Page['getByRole']>, title: string): Promise<void> => {
  // The manual-add strip TOGGLES, so it is opened once and stays open for the next record.
  const titleField = library.getByPlaceholder('Title (required)')
  if (!(await titleField.isVisible().catch(() => false))) {
    await library.getByRole('button', { name: 'Manual add' }).click()
  }
  await titleField.fill(title)
  await library.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(library.getByText(title).first()).toBeVisible()
}

test('screens a collection, names its reasons, and layers a human override over the AI verdict', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  // The model side of a pass is the app's own Agent channel; pointing it at the stub agent is how this
  // spec drives a REAL pass without a provider.
  page = await app.configureFakeAgent()
  await createProject(page, PROJECT_NAME)
  const library = await openLibrary(page)

  await addRecord(library, INCLUDED_TITLE)
  await addRecord(library, EXCLUDED_TITLE)

  // A collection is what a screen runs against.
  const nameField = library.getByPlaceholder('New collection…')
  await nameField.fill(COLLECTION_NAME)
  await nameField.press('Enter')
  const collectionRow = library.getByRole('button', { name: COLLECTION_NAME, exact: true })
  await expect(collectionRow).toBeVisible()
  for (const title of [INCLUDED_TITLE, EXCLUDED_TITLE]) {
    await library.locator('li', { hasText: title }).locator('select').selectOption({
      label: COLLECTION_NAME
    })
  }
  await collectionRow.click()

  // The screening view is offered per collection, and only there.
  await library.getByRole('button', { name: 'Screening', exact: true }).click()
  const panel = library.getByTestId('screening-panel')
  await expect(panel).toBeVisible()

  // Criteria first: a pass with no rule set is refused, and the surface says which revision was written.
  // Exact labels: "Inclusion criteria · Criterion" is a prefix of "... · Criterion ID".
  await panel.getByRole('button', { name: 'Add inclusion criterion' }).click()
  await panel.getByLabel('Inclusion criteria · Criterion ID', { exact: true }).fill('i-1')
  await panel
    .getByLabel('Inclusion criteria · Criterion', { exact: true })
    .fill('Adults with a measured primary endpoint')
  await panel.getByRole('button', { name: 'Add exclusion criterion' }).click()
  await panel.getByLabel('Exclusion criteria · Criterion ID', { exact: true }).fill('e-1')
  await panel
    .getByLabel('Exclusion criteria · Criterion', { exact: true })
    .fill('Systematic reviews and editorials')
  await panel.getByRole('button', { name: 'Save as new revision' }).click()
  await expect(library.getByText('Saved as revision 1.')).toBeVisible()

  // Run the pass. The model really answers (the fixture replies per record with a citation or with
  // counter-evidence), and the pass reports its own progress.
  await panel.getByRole('button', { name: 'Screen collection' }).click()
  await expect(panel.getByText(/AI decisions 2 · human overrides 0/)).toBeVisible({
    timeout: 60_000
  })

  const includedRow = panel.locator('[data-testid="screening-row"]', { hasText: INCLUDED_TITLE })
  const excludedRow = panel.locator('[data-testid="screening-row"]', { hasText: EXCLUDED_TITLE })

  // Both records have metadata only, so the coverage guard turns the model's answers into needs-review:
  // the record whose title asked for an exclusion is NOT excluded, it is uncertain — and the reason is
  // the named one, in words.
  for (const row of [includedRow, excludedRow]) {
    await expect(row.getByText('AI verdict')).toBeVisible()
    await expect(row.getByText('Needs review')).toBeVisible()
    await expect(row.getByText('Metadata only')).toBeVisible()
    await expect(row.getByText('The decision itself is uncertain')).toBeVisible()
  }
  // 每条决策带溯源: the passage the verdict rests on, and the criterion it answers, are on the row.
  await expect(
    includedRow.getByText(/i-1: “Title: Adults with a measured primary endpoint”/)
  ).toBeVisible()
  // 拿不到全文 ⇒ 绝不 excluded: the record the model was told to exclude is uncertain, not excluded.
  await expect(excludedRow.getByText('Excluded')).toHaveCount(0)
  // Nothing is silently left out: the unprocessed count is stated as zero, not omitted.
  await expect(panel.getByText(/unprocessed 0/)).toBeVisible()

  // A person overrides one record. The reason is required, and the AI verdict stays visible beside the
  // human decision.
  await includedRow
    .getByLabel('Why the AI verdict is wrong')
    .fill('the protocol admits this cohort')
  await includedRow.getByRole('button', { name: 'Include', exact: true }).click()
  await expect(includedRow.getByText('Human override')).toBeVisible()
  await expect(includedRow.getByText('the protocol admits this cohort')).toBeVisible()
  await expect(includedRow.getByText('Needs review')).toBeVisible()
  await expect(panel.getByText(/AI decisions 2 · human overrides 1/)).toBeVisible()

  // One click puts the reviewer back on the model's own decision; nothing about it was rewritten.
  await includedRow.getByRole('button', { name: 'Back to the AI verdict' }).click()
  await expect(library.getByText('Override cleared — the AI verdict stands again.')).toBeVisible()
  await expect(includedRow.getByText('Human override')).toHaveCount(0)
  await expect(includedRow.getByText('Needs review')).toBeVisible()

  // Batch override: one reason applied to the whole selection, with a count reported back.
  await panel.getByLabel('Reason').fill('both match the protocol')
  await panel.getByLabel(`Select ${INCLUDED_TITLE}`).click()
  await panel.getByLabel(`Select ${EXCLUDED_TITLE}`).click()
  await panel.getByRole('button', { name: 'Include selected (2)' }).click()
  await expect(library.getByText('Overrode 2 references.')).toBeVisible()
  await expect(panel.getByText(/AI decisions 2 · human overrides 2/)).toBeVisible()

  // The screened collection is the collection the style export covers — screening does not invent a
  // second set. The export notice names GB/T 7714 and the two records.
  await library.getByRole('button', { name: 'Export in the selected style' }).click()
  await expect(library.getByText(/Exported 2 citations in/)).toBeVisible()

  // A rule change is a NEW revision: the notice says how many stored decisions that staled, the history
  // shows both revisions (one current, one superseded), and the reason appears on the row by name.
  await panel.getByRole('button', { name: 'Revision history' }).click()
  await expect(panel.getByText('Revision 1', { exact: false }).first()).toBeVisible()
  await panel
    .getByLabel('Inclusion criteria · Criterion', { exact: true })
    .fill('Adults with a measured primary endpoint and 12 weeks of follow-up')
  await panel.getByRole('button', { name: 'Save as new revision' }).click()
  await expect(library.getByText('Saved as revision 2.', { exact: false })).toBeVisible()
  await expect(library.getByText(RULE_CHANGED_NOTICE, { exact: false })).toBeVisible()
  await expect(panel.getByText('The rule set changed').first()).toBeVisible()
  await expect(panel.getByText('superseded')).toBeVisible()
  // Exact: "current" is a substring of the rows' "Not current" staleness chip.
  await expect(panel.getByText('current', { exact: true })).toBeVisible()
})
