import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// IC27 + IC30, taken as far as they can honestly be taken on this machine.
//
// IC27 (a table with no kind column lands under the request's `defaultKind`) and IC30 (each imported row is
// attributed: which journal, by what match, whether the journal was created) were both landed as pure UI gaps
// — the store already did the work and the IPC already returned the fields, the dialog just never sent the one
// or printed the other. This file certifies the half that runs through the real app end to end, and files the
// window half as a finding rather than hiding it.
//
// CERTIFIED (test 1): a real Electron instance, the real IPC path, a real database write — a kind-less CSV
// with `defaultKind` set imports one row, the row carries that kind, and the outcome carries
// `journalMatch: 'by-issn'` and `journalCreated: true`. That is IC27's store contract and IC30's data contract.
//
// CERTIFIED (test 2): run green on 2026-10-07 — `2 passed (13.1s)` — the window renders the outcome AND the
// attribution:
//     [ic30] claims in the store: [{"kind":"impact-factor","value":"7.3"}]
//     [ic30] the attribution on screen: "landed in Journal of Import Evidence · matched by ISSN · new journal identity"
//
// HISTORY — why this sat as a `fixme` for a while, and why that was never a product defect. The earlier reading
// ("the window's import area never renders its result") was a LOCATOR self-inflicted wound, in two places:
//   ① the submit: `getByRole('button', { name: 'Import' })` matches by SUBSTRING, and the Reference library
//      toolbar renders before the journal metrics panel (`references.importCsl` = "Import CSL style",
//      ReferencesLibraryDialog.tsx:1008; `references.pdfImport.open` = "Import PDFs", :1038; panel at :1141)
//      ⇒ `.first()` clicked "Import CSL style", whose handler opens a hidden native file chooser: it dismisses,
//      nothing is imported, the textbox keeps its text, no result node appears and nothing is logged. That is
//      exactly the shape that was measured, including the two probes that had already ruled out a remount.
//   ② the field: this panel's title, the textarea's aria-label AND its placeholder all read "Import metrics",
//      so a name/placeholder locator can land beside it — and an EMPTY textarea plus `submit`'s first line
//      (`if (text.trim() === '') return`) is silence too: no result, no error, and a click that "landed".
//      The placeholder still being on screen is the tell.
// Both are located by their own slots below. The lesson is the one this file had to learn twice: when a click
// "does nothing", name the ELEMENT and the VALUE before believing anything about the product.
test.setTimeout(180_000)

test('a kind-less table imports under the request kind and lands attributed (IC27 + IC30)', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal import evidence')

  const outcome = await page.evaluate(
    async (): Promise<{
      imported: number
      skipped: number
      journalsCreated: number
      first: {
        kind: string
        value: string
        year: number
        journalMatch: string
        journalCreated: boolean
        line: number
      } | null
    }> => {
      const result = await window.api.references.importJournalMetrics({
        format: 'csv',
        text: [
          'journal,issn,value,year,source',
          'Journal of Import Evidence,9012-3456,7.3,2024,Publisher table'
        ].join('\n'),
        defaultKind: 'impact-factor'
      })
      const first = result.outcomes[0]
      const imported = first && first.status === 'imported' ? first : null
      return {
        imported: result.imported,
        skipped: result.skipped,
        journalsCreated: result.journalsCreated,
        first: imported
          ? {
              kind: imported.kind,
              value: imported.value,
              year: imported.year,
              journalMatch: imported.journalMatch,
              journalCreated: imported.journalCreated,
              line: imported.line ?? -1
            }
          : null
      }
    }
  )
  console.log(`[ic27] kind-less table with defaultKind through the app: ${JSON.stringify(outcome)}`)

  // IC27: the kind came from the request, because the table has no kind column at all.
  expect(outcome.imported).toBe(1)
  expect(outcome.skipped).toBe(0)
  expect(outcome.first?.kind).toBe('impact-factor')
  expect(outcome.first?.value).toBe('7.3')
  expect(outcome.first?.year).toBe(2024)
  // The header row is line 1, so the data row is line 2 — the store counts the table, not the payload.
  expect(outcome.first?.line).toBe(2)
  // IC30: the outcome carries the attribution the window is supposed to print.
  expect(outcome.first?.journalMatch).toBe('by-issn')
  expect(outcome.first?.journalCreated).toBe(true)
  expect(outcome.journalsCreated).toBe(1)

  // And the store holds exactly that, read back the way the panel reads it.
  const stored = await page.evaluate(async (): Promise<{ kind: string; value: string }[]> => {
    const library = await window.api.references.listJournalMetrics()
    const journal = library.journals.find((entry) => entry.issn === '9012-3456')
    if (!journal) return []
    const claims = await window.api.references.listJournalClaims(journal.id)
    return claims.map((claim) => ({ kind: claim.kind, value: claim.value }))
  })
  console.log(`[ic30] claims in the store: ${JSON.stringify(stored)}`)
  expect(stored).toEqual([{ kind: 'impact-factor', value: '7.3' }])
})

// Hung up, not deleted: the window half has a measured defect — see the file header for the evidence and the
// two probes that ruled my own mistakes out.
test('the window renders the import outcome and its attribution (IC30 window half)', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal import evidence window')

  await page.setViewportSize({ width: 1280, height: 800 })
  const projectRow = page.getByRole('button', { name: 'Journal import evidence window' })
  const toggles = page.getByRole('button', { name: 'References' })
  await expect(async () => {
    expect((await toggles.count()) > 0 || (await projectRow.count()) > 0).toBe(true)
  }).toPass({ timeout: 60_000 })
  if ((await toggles.count()) === 0) await projectRow.first().click()
  await toggles.first().click()
  const dialog = page.getByRole('dialog', { name: 'Reference library' })
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await dialog.getByRole('button', { name: 'Journal metrics' }).first().click()

  // The kind control is an input with a suggestion list, not a <select>; the import field is the textbox the
  // panel names after itself ("Import metrics") — locating it by its placeholder can land on the suggestion
  // input beside it, and then the field is empty and the button's guard returns without a word.
  await dialog.locator('[data-slot="journal-metrics-import-default-kind"]').fill('impact-factor')
  // The import field is located by its own slot, not by accessible name: this panel's title, the textarea's
  // aria-label AND its placeholder all read like "Import metrics", so a name/placeholder locator can land on
  // the wrong element, leaving the textarea empty — and then `submit`'s first line (`if (text.trim() === '')
  // return`) returns without a word: no result, no error, and a click that "landed". That silence is exactly
  // what the IC30 window-half立案 was built on; the placeholder still being on screen is the tell.
  const textarea = dialog.locator('[data-slot="journal-metrics-import-text"]')
  await textarea.fill(
    [
      'journal,issn,value,year,source',
      'Journal of Import Evidence,9012-3456,7.3,2024,Publisher table'
    ].join('\n')
  )
  // The submit is located by its own anchor: `getByRole('button', { name: 'Import' })` matches by substring and
  // the toolbar's "Import CSL style" button precedes it in the DOM (see the header).
  await dialog.locator('[data-slot="journal-metrics-import-submit"]').click()

  const summary = dialog.locator('[data-slot="journal-metrics-import-summary"]').first()
  await expect(summary).toBeVisible({ timeout: 60_000 })
  const imported = dialog.getByText(/^line 2:/).first()
  await expect(imported).toBeVisible({ timeout: 30_000 })
  expect((await imported.innerText()).replace(/\s+/g, ' ')).toContain('impact-factor')

  const attribution = dialog.locator('[data-slot="journal-metrics-import-attribution"]').first()
  await expect(attribution).toBeVisible({ timeout: 30_000 })
  const attributionText = (await attribution.innerText()).replace(/\s+/g, ' ')
  console.log(`[ic30] the attribution on screen: "${attributionText}"`)
  expect(attributionText).toContain('matched by ISSN')
  expect(attributionText).toContain('new journal identity')
})
