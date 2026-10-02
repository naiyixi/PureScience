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

  // Into the library through its own toggle, then the panel through its own button.
  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const metricsToggle = dialog.getByRole('button', { name: 'Journal metrics' })
  await expect(metricsToggle).toBeVisible()
  await metricsToggle.click()

  const table = dialog.locator('table')
  await expect(table).toBeVisible()

  // Nature's latest impact factor is on screen WITH its year and its source — all three in one row's text.
  const natureRow = table.locator('tr', { hasText: 'nature' }).first()
  const natureText = (await natureRow.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] nature row: ${natureText}`)
  expect(natureText).toContain('64.8')
  expect(natureText).toContain('2023')
  expect(natureText).toContain('Journal Citation Reports')
  expect(natureText).toContain('一区')
  expect(natureText).toContain('中科院文献情报中心')

  // The kind nobody imported for Nature reads "Unknown" in words — and the row that carries it is not a zero.
  expect(natureText.toLowerCase()).toContain('unknown')
  const metricCells = table.locator('tbody td')
  const cellTexts = (await metricCells.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim())
  console.log(`[panel-reading] cells: ${JSON.stringify(cellTexts)}`)
  expect(cellTexts).not.toContain('0')
  expect(cellTexts.some((text) => text.startsWith('64.8') && text.includes('2023'))).toBe(true)

  // Nature Communications is a different journal with its own number — the panel is not showing one row twice.
  const communicationsRow = table.locator('tr', { hasText: 'nature communications' }).first()
  const communicationsText = (await communicationsRow.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] nature communications row: ${communicationsText}`)
  expect(communicationsText).toContain('16.6')
  expect(communicationsText).not.toContain('64.8')
})
