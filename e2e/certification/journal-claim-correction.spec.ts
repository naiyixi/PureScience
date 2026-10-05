import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// IC29 real-window acceptance: a reader can hand-correct a metric, and the correction joins the claims rather
// than replacing them.
//
// The store has been append-only by doctrine all along (an UPDATE would erase what the source said), and the
// repository enforces it (a missing value is not a zero; an undated or unsourced number is refused) — but no
// channel exposed it, so nothing in the window could write a claim or read a journal's claims back. The
// reading proves both halves: the new claim lands, and the original is still there beside it.
test.setTimeout(180_000)

test('a hand-corrected metric is appended, not substituted', async ({ app }) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal claim evidence')

  // A journal with one imported claim, through the app's own import path. The journal library is
  // application-wide (the import request carries no project), and a journal's spelling is `displayName` when
  // the source had one, falling back to the normalized form.
  const seeded = await page.evaluate(async (): Promise<{ journalName: string; claims: number }> => {
    await window.api.references.importJournalMetrics({
      rows: [
        {
          journalName: 'Journal of Claim Evidence',
          issn: '1234-5678',
          kind: 'impact-factor',
          value: '3.5',
          year: 2024,
          source: 'Publisher table'
        }
      ]
    })
    const library = await window.api.references.listJournalMetrics()
    const journal = library.journals.find(
      (entry) => entry.normalizedName === 'journal of claim evidence'
    )
    const claims = journal ? await window.api.references.listJournalClaims(journal.id) : []
    return {
      journalName: journal?.displayName ?? journal?.normalizedName ?? '',
      claims: claims.length
    }
  })
  console.log(`[ic29] seeded journal "${seeded.journalName}" with ${seeded.claims} claim(s)`)
  expect(seeded.journalName).not.toBe('')
  expect(seeded.claims).toBe(1)

  // Into the window, the way a reader gets there.
  await page.setViewportSize({ width: 1280, height: 800 })
  const projectRow = page.getByRole('button', { name: 'Journal claim evidence' })
  const toggles = page.getByRole('button', { name: 'References' })
  await expect(async () => {
    expect((await toggles.count()) > 0 || (await projectRow.count()) > 0).toBe(true)
  }).toPass({ timeout: 60_000 })
  if ((await toggles.count()) === 0) await projectRow.first().click()
  await toggles.first().click()
  const dialog = page.getByRole('dialog', { name: 'Reference library' })
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await dialog.getByRole('button', { name: 'Journal metrics' }).first().click()

  // The correction form: same journal, a different value, and a source that names who says so. The locators
  // are scoped to this section: the import form beside it also has a "Kind" control, and strict mode is right
  // to refuse an ambiguous one.
  const editor = dialog.getByTestId('journal-claim-editor').first()
  await expect(editor.getByLabel('Value')).toBeVisible({ timeout: 30_000 })
  await editor.getByLabel('Kind').selectOption('impact-factor')
  await editor.getByLabel('Value').fill('4.1')
  await editor.getByLabel('Year').fill('2025')
  await editor.getByLabel('Source').fill('Corrected by hand')
  await editor.getByLabel('Note').fill('Publisher erratum')
  await editor.getByRole('button', { name: 'Add claim' }).first().click()

  // The history shows both claims — the correction did not overwrite the imported one.
  const history = editor.getByTestId('journal-claim-history').first()
  await expect(history).toBeVisible({ timeout: 30_000 })
  const text = (await history.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic29] the claim history on screen: "${text}"`)
  expect(text).toContain('3.5')
  expect(text).toContain('Publisher table')
  expect(text).toContain('4.1')
  expect(text).toContain('Corrected by hand')

  // And main holds two claims, not one — the same question the panel just asked.
  const claims = await page.evaluate(async (): Promise<number> => {
    const library = await window.api.references.listJournalMetrics()
    const journal = library.journals.find(
      (entry) => entry.normalizedName === 'journal of claim evidence'
    )
    return journal ? (await window.api.references.listJournalClaims(journal.id)).length : 0
  })
  console.log(`[ic29] claims in the store after the correction: ${claims}`)
  expect(claims).toBe(2)
})
