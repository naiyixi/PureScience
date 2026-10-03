import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Acceptance for the journal metrics panel's two promises, read off the real window rather than off the pure
// view the panel draws from:
//   * every number on screen carries the year and the source it came from — a bare "64.8" is what this rule
//     exists to prevent;
//   * a metric nobody imported reads "Unknown" in words. Never 0, never blank: a zero would be a claim about
//     the journal, and blank would be indistinguishable from "the panel failed to load".
// The library is seeded through the app's own bridge (the same `importJournalMetrics` call the surface
// exposes), not by poking the database, so what is measured is the path a user's import takes.

test.setTimeout(240_000)

const seed = {
  rows: [
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'impact-factor',
      value: '64.8',
      year: 2023,
      source: 'Journal Citation Reports'
    },
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'impact-factor',
      value: '62.1',
      year: 2022,
      source: 'Journal Citation Reports'
    },
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'cas-partition',
      value: '一区',
      year: 2024,
      source: '中科院文献情报中心'
    },
    {
      issn: '2041-1723',
      journalName: 'Nature Communications',
      kind: 'impact-factor',
      value: '16.6',
      year: 2023,
      source: 'Journal Citation Reports'
    }
  ]
}

test('the metrics panel names year and source, and says Unknown where a metric is missing', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal metrics panel')

  const importResult = await page.evaluate(async (payload) => {
    const bridge = globalThis as unknown as {
      api: {
        references: {
          importJournalMetrics: (
            input: unknown
          ) => Promise<{ imported: number; skipped: number; journalsCreated: number }>
          listJournalMetrics: () => Promise<{ journals: unknown[]; claims: unknown[] }>
        }
      }
    }
    const result = await bridge.api.references.importJournalMetrics(payload)
    const library = await bridge.api.references.listJournalMetrics()

    return { result, journals: library.journals.length, claims: library.claims.length }
  }, seed)

  console.log(`[panel-reading] import: ${JSON.stringify(importResult)}`)
  expect(importResult.result.imported).toBe(4)
  expect(importResult.result.skipped).toBe(0)

  // The brand blue is a claim about this product's own palette, so it is read as a NUMBER off the running
  // window instead of trusted from the stylesheet. Chromium serializes `oklch()` as written, so the computed
  // style alone proves only the token text; painting it on a canvas and reading the pixel is what proves the
  // bytes a button actually shows. Tolerance is ±2 per channel for rounding.
  const primary = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'var(--primary)'
    document.body.appendChild(probe)
    const token = getComputedStyle(probe).backgroundColor
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')
    const painted = 'n/a'
    if (!context) return { token, painted }
    context.fillStyle = token
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    probe.remove()

    return { token, painted: `rgb(${r}, ${g}, ${b})` }
  })
  console.log(`[panel-reading] --primary token: ${primary.token} → paints as: ${primary.painted}`)
  const [r, g, b] = (primary.painted.match(/\d+/g) ?? []).map(Number)
  expect(Math.abs(r - 77)).toBeLessThanOrEqual(2)
  expect(Math.abs(g - 107)).toBeLessThanOrEqual(2)
  expect(Math.abs(b - 254)).toBeLessThanOrEqual(2)

  // Into the library through its own toggle, then the panel through its own button.
  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const metricsToggle = dialog.getByRole('button', { name: 'Journal metrics' })
  await expect(metricsToggle).toBeVisible()
  await metricsToggle.click()
  // A picture of the state the number describes: the panel open, with the primary-coloured toggle pressed.
  await page.screenshot({ path: 'docs/evidence/2026-10-03-primary-brand-blue.png' })

  const table = dialog.locator('table')
  await expect(table).toBeVisible()

  // Nature's latest impact factor is on screen WITH its year and its source — all three in one row's text.
  const natureRow = table.locator('tr', { hasText: 'nature' }).first()
  const natureText = (await natureRow.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] nature row: ${natureText}`)
  // The row shows the source's own spelling, not the normalized form: `nature` on screen would mean the
  // record's display name was never read (R2-U4 reads it; before that the panel could only show the fold).
  expect(natureText.startsWith('Nature ')).toBe(true)
  expect(natureText).toContain('64.8')
  expect(natureText).toContain('2023')
  expect(natureText).toContain('Journal Citation Reports')
  expect(natureText).toContain('一区')
  expect(natureText).toContain('中科院文献情报中心')

  // The kind nobody imported for Nature reads "Unknown" in words — and the row that carries it is not a zero.
  expect(natureText.toLowerCase()).toContain('unknown')
  const metricCells = table.locator('tbody td')
  const cellTexts = (await metricCells.allInnerTexts()).map((text) =>
    text.replace(/\s+/g, ' ').trim()
  )
  console.log(`[panel-reading] cells: ${JSON.stringify(cellTexts)}`)
  expect(cellTexts).not.toContain('0')
  expect(cellTexts.some((text) => text.startsWith('64.8') && text.includes('2023'))).toBe(true)

  // Nature Communications is a different journal with its own number — the panel is not showing one row twice.
  const communicationsRow = table.locator('tr', { hasText: 'nature communications' }).first()
  const communicationsText = (await communicationsRow.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] nature communications row: ${communicationsText}`)
  expect(communicationsText).toContain('16.6')
  expect(communicationsText).not.toContain('64.8')

  // The filter controls, read off the same window: partition, impact-factor floor, year. The panel's own
  // promise here is that a filter that matches nothing says so, and that a year-restricted view does not
  // borrow a figure from another year.
  const rows = async (): Promise<string[]> =>
    (await table.locator('tbody tr').allInnerTexts()).map((text) =>
      text.replace(/\s+/g, ' ').trim()
    )

  await dialog.getByLabel('Partition').selectOption('一区')
  const partitionRows = await rows()
  console.log(`[panel-reading] partition=一区 rows: ${JSON.stringify(partitionRows)}`)
  expect(partitionRows).toHaveLength(1)
  expect(partitionRows[0]).toContain('Nature')
  expect(partitionRows.join(' ')).not.toContain('16.6')

  await dialog.getByLabel('Partition').selectOption('')
  await dialog.getByLabel('Impact factor ≥').fill('999')
  const emptyNotice = dialog.getByText('No journal matches this filter.')
  await expect(emptyNotice).toBeVisible()
  console.log(`[panel-reading] empty-filter notice: ${(await emptyNotice.innerText()).trim()}`)
  expect(await table.locator('tbody tr').count()).toBe(0)

  await dialog.getByLabel('Impact factor ≥').fill('')
  await dialog.getByLabel('Year').fill('2022')
  const yearRows = await rows()
  console.log(`[panel-reading] year=2022 rows: ${JSON.stringify(yearRows)}`)
  const natureIn2022 = yearRows.find((text) => text.startsWith('Nature')) ?? ''
  expect(natureIn2022).toContain('62.1')
  expect(natureIn2022).toContain('2022')
  // The 2024 partition claim does not belong to 2022, so that cell falls back to Unknown instead of showing
  // a figure from another year — and Nature Communications has nothing in 2022 at all.
  expect(natureIn2022).toContain('Unknown')
  expect(yearRows.join(' ')).not.toContain('64.8')
  expect(yearRows.join(' ')).not.toContain('16.6')
})

// The alias/merge reading (R2-U4), taken off the same real window: two spellings that LOOK alike start life as
// two journals (nothing merges similar names behind the reader's back), the user's explicit merge folds them
// into one row, and the spelling that was merged away stays visible as an alias so the surviving row can be
// read without wondering where the other number came from. The refusal branches are covered where they can be
// built honestly — the panel's own render suite drives a refusal result into the control, because the states
// that trigger them (a hand-written row, an id deleted under the window) cannot be produced by clicking.
const mergeSeed = {
  rows: [
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'impact-factor',
      value: '64.8',
      year: 2023,
      source: 'Journal Citation Reports'
    },
    {
      issn: '2041-1723',
      journalName: 'Nature Communications',
      kind: 'impact-factor',
      value: '16.6',
      year: 2023,
      source: 'Journal Citation Reports'
    }
  ]
}

test('an explicit merge folds two journals into one row and keeps the old spelling as an alias', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal merge panel')

  const before = await page.evaluate(async (payload) => {
    const bridge = globalThis as unknown as {
      api: {
        references: {
          importJournalMetrics: (
            input: unknown
          ) => Promise<{ imported: number; skipped: number; journalsCreated: number }>
          listJournalMetrics: () => Promise<{
            journals: Array<{ id: string; normalizedName: string; displayName?: string | null }>
            aliases: unknown[]
          }>
        }
      }
    }
    const result = await bridge.api.references.importJournalMetrics(payload)
    const library = await bridge.api.references.listJournalMetrics()

    return {
      result,
      journals: library.journals.map((journal) => ({
        id: journal.id,
        normalizedName: journal.normalizedName,
        displayName: journal.displayName ?? null
      })),
      aliases: library.aliases.length
    }
  }, mergeSeed)

  console.log(`[panel-reading] merge seed: ${JSON.stringify(before)}`)
  expect(before.result.imported).toBe(2)
  // Two spellings, two journals, zero aliases: similarity alone merged nothing.
  expect(before.journals).toHaveLength(2)
  expect(before.aliases).toBe(0)

  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Journal metrics' }).click()

  const table = dialog.locator('table')
  await expect(table).toBeVisible()
  await expect(table.locator('tbody tr')).toHaveCount(2)

  // The source's own spelling is what the row shows — `nature` (the normalized form) would mean the record's
  // display name was never read.
  const firstRow = (await table.locator('tbody tr').first().innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] row before merge: ${firstRow}`)
  expect(firstRow).toContain('Nature')
  await expect(dialog.locator('[data-slot="journal-alias"]')).toHaveCount(0)

  const confirm = dialog.locator('[data-slot="journal-merge-confirm"]')
  await expect(confirm).toBeDisabled()
  await dialog
    .locator('[data-slot="journal-merge-source"]')
    .selectOption({ label: 'Nature Communications' })
  // Still inert with only one side chosen: the control cannot send a half-formed request.
  await expect(confirm).toBeDisabled()
  await dialog.locator('[data-slot="journal-merge-target"]').selectOption({ label: 'Nature' })
  await expect(confirm).toBeEnabled()

  const result = dialog.locator('[data-slot="journal-merge-result"]')
  await expect(result).toHaveCount(0)
  await confirm.click()
  await expect(result).toBeVisible()
  const resultText = (await result.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] merge result: ${resultText}`)
  // The report names what moved and the spelling that now resolves to the survivor.
  expect(resultText).toContain('1')
  expect(resultText).toContain('nature communications')

  // The table was re-read: one row remains, and the old spelling is on screen as an alias rather than
  // silently gone.
  await expect(table.locator('tbody tr')).toHaveCount(1)
  const mergedRow = (await table.locator('tbody tr').first().innerText())
    .replace(/\s+/g, ' ')
    .trim()
  console.log(`[panel-reading] row after merge: ${mergedRow}`)
  expect(mergedRow).toContain('Nature')
  // One cell, one claim: the 2023 impact factor on screen is the claim fetched last of the two the merge
  // brought onto this journal. The view never prints two numbers in one cell — the read-back below shows both
  // claims are kept, and the count line below the table carries how many journals the filter matched.
  expect(mergedRow).toContain('16.6')
  expect(mergedRow).toContain('Journal Citation Reports')
  const aliasNote = dialog.locator('[data-slot="journal-alias"]')
  await expect(aliasNote).toBeVisible()
  const aliasText = (await aliasNote.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] alias note: ${aliasText}`)
  expect(aliasText).toContain('nature communications')

  // And the store itself, read back through the same bridge the panel reads with: one journal, the old
  // spelling recorded as its alias, and BOTH claims now hanging off the survivor.
  const survivorId =
    before.journals.find((journal) => journal.normalizedName === 'nature')?.id ?? ''
  const after = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        references: {
          listJournalMetrics: () => Promise<{
            journals: Array<{ id: string; normalizedName: string }>
            claims: Array<{ journalId: string; value: string }>
            aliases: Array<{ normalizedName: string; journalId: string }>
          }>
        }
      }
    }
    const library = await bridge.api.references.listJournalMetrics()

    return {
      journals: library.journals.map((journal) => journal.normalizedName),
      aliases: library.aliases.map((alias) => alias.normalizedName),
      aliasTarget: library.aliases[0]?.journalId ?? null,
      claims: library.claims.map((claim) => ({ journalId: claim.journalId, value: claim.value }))
    }
  })
  console.log(`[panel-reading] library after merge: ${JSON.stringify(after)}`)
  expect(after.journals).toEqual(['nature'])
  expect(after.aliases).toEqual(['nature communications'])
  expect(after.aliasTarget).toBe(survivorId)
  expect(after.claims.map((claim) => claim.value).sort()).toEqual(['16.6', '64.8'])
  expect(after.claims.every((claim) => claim.journalId === survivorId)).toBe(true)

  // The control stayed mounted to show that report, but with one journal left it cannot act: the button is
  // inert rather than offering to merge a journal that no longer exists. (Before this reading the panel
  // unmounted the whole block on success, which swallowed the report the user had just asked for.)
  await expect(dialog.getByText('Merge two journals')).toBeVisible()
  await expect(confirm).toBeDisabled()
})

// The import affordance (the surface that used to exist only as an application command): pasting a publisher
// table must produce a PER-ROW outcome — the good row stored, the refused row named — read off the real window.
// One row deliberately has no year: "a metric without a year is not a fact" is the rule this reading is for.
test('the import entry stores the good row and names the refused one', async ({ app }) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal metrics import')

  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Journal metrics' }).click()

  const csv = [
    'journal,issn,kind,value,year,source',
    'Nature,0028-0836,impact-factor,64.8,2023,Journal Citation Reports',
    'Nature Communications,2041-1723,impact-factor,16.6,,Journal Citation Reports'
  ].join('\n')
  await dialog.getByLabel('Import metrics').fill(csv)
  await dialog.locator('[data-slot="journal-metrics-import-submit"]').click()

  const summary = dialog.locator('[data-slot="journal-metrics-import-summary"]')
  await expect(summary).toBeVisible()
  const summaryText = (await summary.innerText()).replace(/\s+/g, ' ').trim()
  const importedLines = (
    await dialog.locator('[data-slot="journal-metrics-import-imported"]').allInnerTexts()
  ).map((text) => text.replace(/\s+/g, ' ').trim())
  const skippedLines = (
    await dialog.locator('[data-slot="journal-metrics-import-skipped"]').allInnerTexts()
  ).map((text) => text.replace(/\s+/g, ' ').trim())
  console.log(`[panel-reading] import summary: ${summaryText}`)
  console.log(`[panel-reading] import imported rows: ${JSON.stringify(importedLines)}`)
  console.log(`[panel-reading] import skipped rows: ${JSON.stringify(skippedLines)}`)

  // One row stored, one refused — and the refusal says WHICH row and WHY, not just that something failed.
  expect(importedLines).toHaveLength(1)
  expect(importedLines[0]).toContain('64.8')
  expect(skippedLines).toHaveLength(1)
  expect(skippedLines[0].toLowerCase()).toContain('no year')

  // The table above now shows what the import stored, because the panel re-read the library.
  const table = dialog.locator('table')
  await expect(table.locator('tr', { hasText: 'Nature' }).first()).toBeVisible()
})
