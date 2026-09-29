import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for S5, on a real window over the real IPC surface and a real project database: the
// coverage checklist of one collection, with a corpus whose records genuinely reach three of the four
// evidence tiers.
//
// What this walks, and why each assertion is here:
//
//   * five members are built through the app's own paths — a record with a REAL PDF attached, imported
//     through the library's own PDF picker from a project PDF the fixture agent wrote and read back by
//     the app's own PDF service (so the tier is 'full-text'), a record with an abstract but no PDF
//     ('abstract-only'), and three records with a title only ('metadata-only');
//   * the checklist is asserted from the ROWS it renders — the tier memberships are re-counted in the
//     spec and must reproduce the four counts, and the union must be exactly the collection's members
//     with no repeats (每篇恰属其一);
//   * the unprocessed quantity is asserted before the pass (five records, all five named) and after it
//     (zero, stated), so neither "we have not looked" nor "nothing is left" can be conveyed by silence;
//   * both totals are read off the panel: the searched total with the scope it is measured over, the
//     candidate total beside it, and the reconciliation line saying the four tiers add up.

const PROJECT_NAME = 'Screening coverage acceptance project'
const COLLECTION_NAME = 'Coverage hits'
// The fixture PDF's file name and the record title the picker derives from it (extension stripped,
// separators turned into spaces).
const PDF_FILE_NAME = 'table-evidence.pdf'
const PDF_TITLE = 'table evidence'
const ABSTRACT_TITLE = 'Abstract only: cohort with a measured endpoint'
const METADATA_TITLES = ['Metadata only A', 'Metadata only B', 'Metadata only C']
const ABSTRACT_TEXT = 'We enrolled 120 adults and measured the primary endpoint over twelve weeks.'
const ALL_TITLES = [PDF_TITLE, ABSTRACT_TITLE, ...METADATA_TITLES]

/** Where a screenshot of the checklist is written when asked for (see the S5 evidence record). */
const EVIDENCE_DIR = process.env.PURESCIENCE_EVIDENCE_DIR

test.setTimeout(240_000)

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

type CoverageGroup = { coverage: string; count: number }
type CoverageItem = { referenceId: string; coverage: string; unprocessed: boolean }

/** The four tiers as the checklist renders them: its own count beside its own membership list. */
const readCoverageGroups = async (panel: Locator): Promise<CoverageGroup[]> => {
  const groups = await panel.locator('[data-testid="screening-coverage-group"]').all()
  return Promise.all(
    groups.map(async (group) => ({
      coverage: (await group.getAttribute('data-coverage')) ?? '',
      count: Number((await group.getAttribute('data-count')) ?? '0')
    }))
  )
}

/** Every tier membership row, read off the DOM — the list the four counts are checked against. */
const readCoverageItems = async (panel: Locator): Promise<CoverageItem[]> => {
  const items = await panel.locator('[data-testid="screening-coverage-item"]').all()
  return Promise.all(
    items.map(async (item) => ({
      referenceId: (await item.getAttribute('data-reference-id')) ?? '',
      coverage: (await item.getAttribute('data-coverage')) ?? '',
      unprocessed: (await item.getAttribute('data-unprocessed')) === 'true'
    }))
  )
}

const readRows = async (panel: Locator): Promise<{ referenceId: string; coverage: string }[]> => {
  const rows = await panel.locator('[data-testid="screening-row"]').all()
  return Promise.all(
    rows.map(async (row) => ({
      referenceId: (await row.getAttribute('data-reference-id')) ?? '',
      coverage: (await row.getAttribute('data-coverage')) ?? ''
    }))
  )
}

/**
 * One checklist reading, written out verbatim — used by the S5 evidence record so every number there can
 * be traced back to text this run produced, not to a paraphrase of it.
 */
const collectChecklistReadings = async (
  panel: Locator,
  list: Locator,
  label: string
): Promise<string[]> => {
  const groups = await readCoverageGroups(panel)
  const items = await readCoverageItems(panel)
  const unprocessedRows = await panel
    .locator('[data-testid="screening-coverage-unprocessed-item"]')
    .allTextContents()
  const attribute = async (name: string): Promise<string> => (await list.getAttribute(name)) ?? ''
  const line = async (testId: string): Promise<string> =>
    ((await panel.getByTestId(testId).textContent()) ?? '').trim()
  return [
    `${label}:`,
    `  data-scope: ${await attribute('data-scope')}`,
    `  data-searched: ${await attribute('data-searched')}`,
    `  data-candidate: ${await attribute('data-candidate')}`,
    `  data-classified: ${await attribute('data-classified')}`,
    `  data-reconciled: ${await attribute('data-reconciled')}`,
    `  data-within-searched: ${await attribute('data-within-searched')}`,
    `  data-unprocessed: ${await attribute('data-unprocessed')}`,
    `  reconcile line: ${await line('screening-coverage-reconcile')}`,
    `  reconciliation line: ${await line('screening-coverage-reconciliation')}`,
    `  unprocessed line: ${await line('screening-coverage-unprocessed-line')}`,
    `  unprocessed rows listed (${unprocessedRows.length}): ${unprocessedRows.join(' | ')}`,
    '  four tiers:',
    ...groups.map((group) => `    ${group.coverage}: ${group.count}`),
    `  tier memberships (${items.length}, one per reference):`,
    ...items.map(
      (entry) => `    ${entry.referenceId} -> ${entry.coverage} (unprocessed: ${entry.unprocessed})`
    ),
    ''
  ]
}

test('reconciles one collection’s coverage tiers against a real corpus', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, PROJECT_NAME)

  // A record with an abstract but nothing to read in full. Created through the app's own library
  // channel (the same one the "add by identifier" path uses) because the manual-add form has no
  // abstract field: the tier is what the LIBRARY holds, not what a form happens to expose.
  await page.evaluate(
    async ({ projectId, title, abstract }) => {
      const bridge = globalThis as unknown as {
        api: {
          references: {
            add: (input: unknown) => Promise<{ status: string; reference: { id: string } }>
          }
        }
      }
      const added = await bridge.api.references.add({
        projectId,
        title,
        authors: [{ name: 'Ada Lovelace' }],
        abstractSnippet: abstract,
        sourceConnector: 'manual'
      })
      if (added.status !== 'created')
        throw new Error(`the abstract record was not created: ${added.status}`)
    },
    { projectId, title: ABSTRACT_TITLE, abstract: ABSTRACT_TEXT }
  )

  // A real PDF in the project, written by the fixture agent through the app's own artifact tool — the
  // only way a record in this library can have full text at all.
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 90_000)

  // The PDF becomes a record with the file attached THROUGH THE PICKER ITSELF: the library's own
  // "Import PDFs" button opens it, the project's PDF is asserted to be in its list, that entry is
  // ticked, and the import turns the file name into a record title and attaches the file. Nothing here
  // calls references.add/references.attachPdf behind the interface — the tier under test is produced by
  // the same click a user would make.
  //
  // Two defects used to make this button unwalkable, and both are fixed: the picker asked the project
  // file index for 500 rows, and the index rejects any limit above 100, so the rejection surfaced as
  // "no PDFs in this project" on a button whose whole job is to find PDFs (the picker now walks the
  // index's cursor one allowed page at a time, capped at the original 500-entry intent); and every label
  // in this area was hardcoded Chinese, so a non-Chinese interface showed Chinese (the labels now come
  // from the dictionaries, in all nine languages).
  // The picker below reads the project file index once, when it opens, so wait for the app to have
  // indexed the fixture first. This is a READ-ONLY readiness wait — it neither creates the record nor
  // attaches the file; every write in this test happens through the interface.
  await expect
    .poll(
      async () =>
        page.evaluate(async (projectId: string) => {
          const bridge = globalThis as unknown as {
            api: {
              projectFiles: {
                listFiles: (request: unknown) => Promise<{
                  items: Array<{ name: string; mimeType?: string }>
                }>
              }
            }
          }
          const listed = await bridge.api.projectFiles.listFiles({
            projectId,
            collection: { kind: 'all' },
            limit: 100
          })
          return listed.items.some(
            (item) =>
              item.name.toLowerCase().endsWith('.pdf') ||
              item.mimeType?.toLowerCase() === 'application/pdf'
          )
        }, projectId),
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toBe(true)

  const library = await openLibrary(page)
  await library.getByRole('button', { name: 'Import PDFs' }).click()
  const pickerEntry = library.locator('label', { hasText: PDF_FILE_NAME })
  await expect(pickerEntry).toBeVisible()
  await pickerEntry.getByRole('checkbox').check()
  await library.getByRole('button', { name: 'Import as new records (1)' }).click()
  await expect(library.getByText('Imported 1 PDF file(s).')).toBeVisible()
  // The picker closed itself and the new record is in the list, named after the file.
  await expect(library.getByRole('checkbox')).toHaveCount(0)
  await expect(library.getByText(PDF_TITLE).first()).toBeVisible()

  for (const title of METADATA_TITLES) await addRecord(library, title)

  const nameField = library.getByPlaceholder('New collection…')
  await nameField.fill(COLLECTION_NAME)
  await nameField.press('Enter')
  const collectionRow = library.getByRole('button', { name: COLLECTION_NAME, exact: true })
  await expect(collectionRow).toBeVisible()
  for (const title of ALL_TITLES) {
    await library.locator('li', { hasText: title }).locator('select').selectOption({
      label: COLLECTION_NAME
    })
  }
  await collectionRow.click()

  await library.getByRole('button', { name: 'Screening', exact: true }).click()
  const panel = library.getByTestId('screening-panel')
  await expect(panel).toBeVisible()

  // --- the checklist, before anything has been screened -------------------------------------------
  const list = panel.getByTestId('screening-coverage-list')
  await expect(list).toBeVisible()
  // Both totals, with the searched total's scope NAMED on the surface — the collection's members, not a
  // retrieval count this build never measures.
  expect(await list.getAttribute('data-scope')).toBe('collection-members')
  expect(await list.getAttribute('data-searched')).toBe('5')
  expect(await list.getAttribute('data-candidate')).toBe('5')
  expect(await list.getAttribute('data-classified')).toBe('5')
  expect(await list.getAttribute('data-within-searched')).toBe('true')
  expect(await list.getAttribute('data-reconciled')).toBe('true')
  expect(await list.getAttribute('data-unprocessed')).toBe('5')
  await expect(panel.getByTestId('screening-coverage-reconcile')).toContainText(
    "Searched 5 (the collection's members) · candidates 5 · the four tiers total 5"
  )
  await expect(panel.getByTestId('screening-coverage-reconciliation')).toContainText(
    'The four tiers add up to the candidate count: 5.'
  )
  await expect(panel.locator('[data-testid="screening-coverage-violations"]')).toHaveCount(0)

  // Three of the four tiers are really populated on this corpus: the PDF record reads as full text, the
  // abstract record as abstract only, the three title-only records as metadata only.
  expect(await readCoverageGroups(panel)).toEqual([
    { coverage: 'full-text', count: 1 },
    { coverage: 'abstract-only', count: 1 },
    { coverage: 'metadata-only', count: 3 },
    { coverage: 'unavailable', count: 0 }
  ])

  // 每篇恰属其一, re-counted in the spec from the rendered memberships: five rows, five distinct
  // references, each tier list exactly as long as its own count, and the whole list the same set as the
  // collection's rows.
  let items = await readCoverageItems(panel)
  expect(items).toHaveLength(5)
  expect(new Set(items.map((entry) => entry.referenceId)).size).toBe(5)
  for (const group of await readCoverageGroups(panel)) {
    expect(items.filter((entry) => entry.coverage === group.coverage)).toHaveLength(group.count)
  }
  let rows = await readRows(panel)
  expect(rows).toHaveLength(5)
  expect(new Set(rows.map((row) => row.referenceId))).toEqual(
    new Set(items.map((entry) => entry.referenceId))
  )
  expect(new Set(rows.map((row) => row.coverage))).toEqual(
    new Set(items.map((entry) => entry.coverage))
  )

  // 未处理量显式: nothing has been screened, so all five are named — a count and a list, not silence.
  await expect(panel.getByTestId('screening-coverage-unprocessed-line')).toContainText(
    'Unprocessed 5 — listed one by one, never omitted:'
  )
  const listedTitles = await panel
    .locator('[data-testid="screening-coverage-unprocessed-item"]')
    .allTextContents()
  expect(listedTitles).toHaveLength(5)
  expect(listedTitles.join('\n')).toContain(PDF_TITLE)
  for (const title of [ABSTRACT_TITLE, ...METADATA_TITLES]) {
    expect(listedTitles.join('\n')).toContain(title)
  }
  expect(
    await panel.locator('[data-testid="screening-coverage-unprocessed-item"]').all()
  ).toHaveLength(5)
  expect(items.filter((entry) => entry.unprocessed)).toHaveLength(5)

  if (EVIDENCE_DIR) {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({
      path: join(EVIDENCE_DIR, '2026-09-29-literature-screening-coverage-list.png'),
      fullPage: true
    })
    await writeFile(
      join(EVIDENCE_DIR, '2026-09-29-literature-screening-readings-before-pass.txt'),
      [
        `collected-at: ${new Date().toISOString()}`,
        `collection: ${COLLECTION_NAME} (project: ${PROJECT_NAME})`,
        '',
        ...(await collectChecklistReadings(
          panel,
          list,
          'checklist before the pass (nothing screened)'
        ))
      ].join('\n')
    )
  }

  // --- run a real pass, then re-read the same checklist -------------------------------------------
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

  await expect(panel.locator('[data-testid="screening-coverage-unprocessed-item"]')).toHaveCount(5)

  await panel.getByRole('button', { name: 'Screen collection' }).click()
  await expect(panel.getByText(/AI decisions 5 · human overrides 0/)).toBeVisible({
    timeout: 120_000
  })

  // The tiers are a property of the EVIDENCE, so a pass must not move them; what the pass moves is the
  // unprocessed quantity, and it says so explicitly now that it is zero.
  expect(await readCoverageGroups(panel)).toEqual([
    { coverage: 'full-text', count: 1 },
    { coverage: 'abstract-only', count: 1 },
    { coverage: 'metadata-only', count: 3 },
    { coverage: 'unavailable', count: 0 }
  ])
  expect(await list.getAttribute('data-unprocessed')).toBe('0')
  expect(await list.getAttribute('data-classified')).toBe('5')
  expect(await list.getAttribute('data-reconciled')).toBe('true')
  expect(await list.getAttribute('data-searched')).toBe('5')
  expect(await list.getAttribute('data-candidate')).toBe('5')
  await expect(panel.getByTestId('screening-coverage-unprocessed-line')).toContainText(
    'Unprocessed 0 — listed one by one, never omitted:'
  )
  await expect(panel.locator('[data-testid="screening-coverage-unprocessed-item"]')).toHaveCount(0)

  // The partition still holds, and the rows still agree with it.
  items = await readCoverageItems(panel)
  rows = await readRows(panel)
  expect(items).toHaveLength(5)
  expect(new Set(items.map((entry) => entry.referenceId)).size).toBe(5)
  for (const group of await readCoverageGroups(panel)) {
    expect(rows.filter((row) => row.coverage === group.coverage)).toHaveLength(group.count)
  }
  expect(items.every((entry) => !entry.unprocessed)).toBe(true)

  // The statistics beside the checklist read the same ledger: a full-text record can be included, the
  // two weaker tiers could not be — which is the coverage guard visible on the machine.
  expect((await panel.getByTestId('screening-stat-ai').textContent())?.trim()).toBe(
    'AI decisions 5'
  )
  expect((await panel.getByTestId('screening-stat-unprocessed').textContent())?.trim()).toBe(
    'Unprocessed 0'
  )
  expect((await panel.getByTestId('screening-stat-coverage-full-text').textContent())?.trim()).toBe(
    'Full text 1'
  )
  expect((await panel.getByTestId('screening-stat-verdict-included').textContent())?.trim()).toBe(
    'Included 1'
  )
  expect(
    (await panel.getByTestId('screening-stat-verdict-needs-review').textContent())?.trim()
  ).toBe('Needs review 4')

  // The raw readings this acceptance is archived from (see docs/evidence/2026-09-29-literature-
  // screening.md). Written only when asked for, so a CI run leaves no trace behind it.
  if (EVIDENCE_DIR) {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    const statLine = async (testId: string): Promise<string> =>
      ((await panel.getByTestId(testId).textContent()) ?? '').trim()
    await writeFile(
      join(EVIDENCE_DIR, '2026-09-29-literature-screening-coverage-readings.txt'),
      [
        `collected-at: ${new Date().toISOString()}`,
        `collection: ${COLLECTION_NAME} (project: ${PROJECT_NAME})`,
        '',
        ...(await collectChecklistReadings(panel, list, 'checklist after the pass')),
        'statistics beside the checklist:',
        `  ${await statLine('screening-stat-ai')}`,
        `  ${await statLine('screening-stat-overrides')}`,
        `  ${await statLine('screening-stat-unprocessed')}`,
        ...(await Promise.all(
          ['included', 'needs-review', 'excluded', 'not-evaluated'].map(
            async (verdict) => `  ${await statLine(`screening-stat-verdict-${verdict}`)}`
          )
        )),
        ...(await Promise.all(
          ['full-text', 'abstract-only', 'metadata-only', 'unavailable'].map(
            async (coverage) => `  ${await statLine(`screening-stat-coverage-${coverage}`)}`
          )
        )),
        ''
      ].join('\n')
    )
  }
})
