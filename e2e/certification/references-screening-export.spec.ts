import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Acceptance for S4, on a real window over the real IPC surface and a real project database: the
// triage result goes straight into the library's GB/T 7714 export, and the statistics are read from the
// ledger the screen shows.
//
// What this walks, and why each assertion is here:
//
//   * three records are screened for real (the repository's existing stub agent stands in for the
//     model, so prompt assembly, the guardrails, the parse and the ledger write all happen);
//   * the statistics panel states AI decisions / human overrides / unprocessed as three separate
//     numbers, and those numbers are CROSS-CHECKED against the rows' own state — the "库内逐项一致"
//     requirement, asserted from the rendered lines rather than from the panel's word;
//   * a human override is applied in BOTH directions (one record a person includes, one a person
//     excludes) while the AI verdicts stay exactly where they were;
//   * the export is a real file on disk (the one seam replaced is the native save dialog, because no
//     test can operate one): its contents contain ONLY the effective "included" record, and the receipt
//     names what stayed out, by state and by named reason, with the rule revision it was judged against.

const PROJECT_NAME = 'Screening export acceptance project'
const COLLECTION_NAME = 'Screen hits'
const INCLUDED_TITLE = 'Adults with a measured primary endpoint'
const EXCLUDED_TITLE = 'Please exclude me: a systematic review'
const UNTOUCHED_TITLE = 'Untouched: a case series'

/** Where the S5 evidence record's raw export dump is written, when one is asked for. */
const EVIDENCE_DIR = process.env.PURESCIENCE_EVIDENCE_DIR

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

/** The visible number of one statistics line ("AI decisions 3" -> "3"). */
const statText = async (panel: Locator, testId: string): Promise<string> =>
  ((await panel.getByTestId(testId).textContent()) ?? '').trim()

type RowState = {
  referenceId: string
  verdict: string
  effective: string
  effectiveSource: string
  coverage: string
  override: string
}

/** Every screening line's own state, read off the rows instead of from the aggregate. */
const readRows = async (panel: Locator): Promise<RowState[]> => {
  const rows = await panel.locator('[data-testid="screening-row"]').all()
  return Promise.all(
    rows.map(async (row) => ({
      referenceId: (await row.getAttribute('data-reference-id')) ?? '',
      verdict: (await row.getAttribute('data-verdict')) ?? '',
      effective: (await row.getAttribute('data-effective')) ?? '',
      effectiveSource: (await row.getAttribute('data-effective-source')) ?? '',
      coverage: (await row.getAttribute('data-coverage')) ?? '',
      override: (await row.getAttribute('data-override')) ?? ''
    }))
  )
}

test('screens a collection, overrides two records, and exports only the included ones', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, PROJECT_NAME)
  const library = await openLibrary(page)

  await addRecord(library, INCLUDED_TITLE)
  await addRecord(library, EXCLUDED_TITLE)
  await addRecord(library, UNTOUCHED_TITLE)

  const nameField = library.getByPlaceholder('New collection…')
  await nameField.fill(COLLECTION_NAME)
  await nameField.press('Enter')
  const collectionRow = library.getByRole('button', { name: COLLECTION_NAME, exact: true })
  await expect(collectionRow).toBeVisible()
  for (const title of [INCLUDED_TITLE, EXCLUDED_TITLE, UNTOUCHED_TITLE]) {
    await library.locator('li', { hasText: title }).locator('select').selectOption({
      label: COLLECTION_NAME
    })
  }
  await collectionRow.click()

  await library.getByRole('button', { name: 'Screening', exact: true }).click()
  const panel = library.getByTestId('screening-panel')
  await expect(panel).toBeVisible()

  // Criteria first: a pass with no rule set is refused, and the revision that was written is named.
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

  // The pass really runs; the records have metadata only, so the coverage guard turns every answer into
  // needs-review and nothing is decided yet.
  await panel.getByRole('button', { name: 'Screen collection' }).click()
  await expect(panel.getByText(/AI decisions 3 · human overrides 0/)).toBeVisible({
    timeout: 60_000
  })
  for (const title of [INCLUDED_TITLE, EXCLUDED_TITLE, UNTOUCHED_TITLE]) {
    const row = panel.locator('[data-testid="screening-row"]', { hasText: title })
    await expect(row.getByText('Metadata only')).toBeVisible()
    await expect(row.getByText('Needs review')).toBeVisible()
  }

  // --- the statistics panel, before any human decision -------------------------------------------
  // AI 判定数 / 人工覆盖数 / 未处理数 are three separate numbers, and 未处理量 is labelled as such.
  expect(await statText(panel, 'screening-stat-ai')).toBe('AI decisions 3')
  expect(await statText(panel, 'screening-stat-overrides')).toBe('Human overrides 0')
  expect(await statText(panel, 'screening-stat-unprocessed')).toBe('Unprocessed 0')
  await expect(panel.getByTestId('screening-stats')).toContainText(
    'Unprocessed records are counted separately and never enter an export.'
  )
  // The four-state distribution and the evidence-coverage distribution, per state.
  expect(await statText(panel, 'screening-stat-verdict-included')).toBe('Included 0')
  expect(await statText(panel, 'screening-stat-verdict-needs-review')).toBe('Needs review 3')
  expect(await statText(panel, 'screening-stat-verdict-excluded')).toBe('Excluded 0')
  expect(await statText(panel, 'screening-stat-verdict-not-evaluated')).toBe('Not evaluated 0')
  expect(await statText(panel, 'screening-stat-coverage-metadata-only')).toBe('Metadata only 3')
  expect(await statText(panel, 'screening-stat-coverage-full-text')).toBe('Full text 0')

  // 与库内逐项一致: recomputed from the lines themselves, the same numbers come out.
  let rows = await readRows(panel)
  expect(rows).toHaveLength(3)
  expect(rows.map((row) => row.verdict)).toEqual(['needs-review', 'needs-review', 'needs-review'])
  expect(rows.filter((row) => row.verdict !== 'not-evaluated')).toHaveLength(3)
  expect(rows.filter((row) => row.verdict === 'not-evaluated')).toHaveLength(0)
  expect(rows.filter((row) => row.override !== '')).toHaveLength(0)
  expect(rows.filter((row) => row.coverage === 'metadata-only')).toHaveLength(3)
  // The coverage column and the AI column are the same lines the pass wrote: every row carries its
  // decision and its evidence tier, and none of them is silently missing.
  expect(rows.map((row) => row.effective)).toEqual(['needs-review', 'needs-review', 'needs-review'])

  // --- a person decides, in both directions ------------------------------------------------------
  const includedRow = panel.locator('[data-testid="screening-row"]', { hasText: INCLUDED_TITLE })
  const excludedRow = panel.locator('[data-testid="screening-row"]', { hasText: EXCLUDED_TITLE })

  await includedRow
    .getByLabel('Why the AI verdict is wrong')
    .fill('the protocol admits this cohort')
  await includedRow.getByRole('button', { name: 'Include', exact: true }).click()
  await expect(includedRow.getByText('Human override')).toBeVisible()

  await excludedRow.getByLabel('Why the AI verdict is wrong').fill('retracted after screening')
  await excludedRow.getByRole('button', { name: 'Exclude', exact: true }).click()
  await expect(excludedRow.getByText('Human override')).toBeVisible()

  await expect(panel.getByText(/AI decisions 3 · human overrides 2/)).toBeVisible()
  // The AI layer did not move: the overrides are a layer beside it, so the four-state distribution is
  // still three needs-review rows while the effective verdicts are now included / excluded / review.
  expect(await statText(panel, 'screening-stat-overrides')).toBe('Human overrides 2')
  expect(await statText(panel, 'screening-stat-verdict-needs-review')).toBe('Needs review 3')
  expect(await statText(panel, 'screening-stat-ai')).toBe('AI decisions 3')
  expect(await statText(panel, 'screening-stat-unprocessed')).toBe('Unprocessed 0')
  rows = await readRows(panel)
  expect(rows.filter((row) => row.override !== '')).toHaveLength(2)
  expect(rows.filter((row) => row.effectiveSource === 'override')).toHaveLength(2)
  expect(rows.filter((row) => row.effective === 'included')).toHaveLength(1)
  expect(rows.filter((row) => row.effective === 'excluded')).toHaveLength(1)
  // 人工覆盖不改写 AI 原判: the included row still shows the model's own "Needs review" beside the
  // human "Include", which is where the export takes it from. Exact text, because the row's
  // "Back to the AI verdict" button also contains the words.
  await expect(includedRow.getByText('AI verdict', { exact: true })).toBeVisible()
  await expect(includedRow.getByText('Needs review')).toBeVisible()
  await expect(includedRow.getByText('the protocol admits this cohort')).toBeVisible()

  // --- the export range is stated before the button ----------------------------------------------
  const exportBox = panel.getByTestId('screening-export')
  await expect(exportBox).toHaveAttribute('data-scope', 'included-only')
  await expect(panel.getByTestId('screening-export-scope')).toContainText('included only')
  await expect(panel.getByTestId('screening-export-preview')).toContainText(
    'Will export 1 · not exported 2 (needs review 1 · excluded 1 · not evaluated 0)'
  )

  // --- press it: a real file on disk -------------------------------------------------------------
  const root = await mkdtemp(join(tmpdir(), 'ps-screening-export-'))
  const target = join(root, 'screening-export.txt')
  try {
    await app.stubSaveDialog(target)
    await panel.getByRole('button', { name: 'Export included' }).click()

    const receipt = panel.getByTestId('screening-export-receipt')
    await expect(receipt).toBeVisible()
    await expect(panel.getByTestId('screening-export-receipt-summary')).toContainText(
      'Exported 1 included citations in GB/T 7714-2015 (numeric) · scope included only.'
    )
    // 判定四态与具名原因不得因导出而丢失: the receipt says how many stayed out, per state, and WHY.
    await expect(panel.getByTestId('screening-export-receipt-not-exported')).toContainText(
      'Not exported 2: needs review 1 · excluded 1 · not evaluated 0 · by a human override 1'
    )
    await expect(panel.getByTestId('screening-export-receipt-reasons')).toContainText(
      'The decision itself is uncertain: 2'
    )
    // 可溯源: the collection, the rule revision it was judged against, and the moment.
    await expect(panel.getByTestId('screening-export-receipt-provenance')).toContainText(
      `collection ${COLLECTION_NAME} · rule revision 1`
    )
    await expect(panel.getByTestId('screening-export-receipt-path')).toContainText(
      `Saved to ${target}.`
    )

    // The file is really there, and it contains ONLY the record whose effective verdict is included.
    expect((await stat(target)).size).toBeGreaterThan(0)
    const exported = await readFile(target, 'utf8')
    expect(exported).toContain(INCLUDED_TITLE)
    expect(exported).not.toContain(EXCLUDED_TITLE)
    expect(exported).not.toContain(UNTOUCHED_TITLE)
    // One citation per included record: no header, no stray blank entry, nothing else.
    expect(exported.trim().split('\n')).toHaveLength(1)
    // The library's own GB/T 7714 numbering is what the file uses.
    expect(exported.trim()).toMatch(/^\[1\] /)

    // The export read the ledger and wrote a file; it changed nothing about the triage. The statistics
    // are re-read after the action and still agree with the rows.
    expect(await statText(panel, 'screening-stat-ai')).toBe('AI decisions 3')
    expect(await statText(panel, 'screening-stat-overrides')).toBe('Human overrides 2')
    expect(await statText(panel, 'screening-stat-unprocessed')).toBe('Unprocessed 0')
    rows = await readRows(panel)
    expect(rows.filter((row) => row.effective === 'included')).toHaveLength(1)
    expect(rows.filter((row) => row.effective === 'excluded')).toHaveLength(1)
    expect(rows.filter((row) => row.effective === 'needs-review')).toHaveLength(1)

    // The name the app asked the file to carry: scope, collection, rule revision, style and the day, so a
    // bibliography on someone's disk is attributable to a revision rather than to a mood. Read off the
    // native save dialog the export handed it to (the stub records the options; it does not invent them).
    const dialogOptions = await app.lastSaveDialogOptions()
    const suggestedName = dialogOptions?.defaultPath ?? ''
    expect(suggestedName).toMatch(
      /^references-screen-hits-included-only-r1-gbt7714-2015-\d{4}-\d{2}-\d{2}\.txt$/
    )

    // The raw readings this acceptance is archived from (see docs/evidence/2026-09-29-literature-
    // screening.md). Written only when asked for, so a CI run leaves no trace behind it.
    if (EVIDENCE_DIR) {
      await mkdir(EVIDENCE_DIR, { recursive: true })
      const receiptLines = await Promise.all(
        [
          'screening-export-receipt-summary',
          'screening-export-receipt-not-exported',
          'screening-export-receipt-reasons',
          'screening-export-receipt-provenance',
          'screening-export-receipt-path'
        ].map(async (testId) => `${testId}: ${(await statText(panel, testId)) || '(absent)'}`)
      )
      await writeFile(
        join(EVIDENCE_DIR, '2026-09-29-literature-screening-export-receipt.txt'),
        [
          `collected-at: ${new Date().toISOString()}`,
          `exported-file-name (suggested by the app): ${suggestedName}`,
          `saved-path (stubbed save dialog): ${target}`,
          `file-bytes: ${(await stat(target)).size}`,
          `citation-lines: ${(await readFile(target, 'utf8')).trim().split('\n').length}`,
          '',
          'receipt:',
          ...receiptLines,
          '',
          'exported file verbatim:',
          (await readFile(target, 'utf8')).trimEnd(),
          ''
        ].join('\n')
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
