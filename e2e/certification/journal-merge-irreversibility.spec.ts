import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// IC49: a journal merge has no undo — the kept journal absorbs the metrics and the references, and the other
// name stays as an alias that resolves here. The panel says so in words BEFORE the button, which is the whole
// of what this row had left: either un-merge exists, or the interface states plainly that it does not.
//
// This reading checks both halves: that the sentence is really on screen, and that a merge performed through
// the panel's own form really leaves the losing name behind as an alias.
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
      issn: '0028-0837',
      journalName: 'Nature (London)',
      kind: 'impact-factor',
      value: '61.2',
      year: 2023,
      source: 'Journal Citation Reports'
    }
  ]
}

test('says a journal merge cannot be undone, and leaves the other name as an alias', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal merge irreversibility')

  // Seeded through the app's own bridge, the same call the import surface makes.
  const imported = await page.evaluate(async (payload) => {
    const bridge = globalThis as unknown as {
      api: { references: { importJournalMetrics: (input: unknown) => Promise<unknown> } }
    }
    return bridge.api.references.importJournalMetrics(payload)
  }, seed)
  console.log(`[ic49] import result: ${JSON.stringify(imported)}`)

  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Journal metrics' }).click()

  // The promise the decision rests on: the interface says the merge cannot be undone, before the button.
  const hint = dialog.getByText(/cannot be undone/i)
  await expect(hint).toBeVisible({ timeout: 30_000 })
  console.log(
    `[ic49] the merge form says: "${(await hint.innerText()).replace(/\s+/g, ' ').trim()}"`
  )

  // A real merge through the panel's own form. The selects list journal ids, so they are chosen by position:
  // index 0 is the "choose a journal…" placeholder.
  const source = dialog.locator('[data-slot="journal-merge-source"]')
  const target = dialog.locator('[data-slot="journal-merge-target"]')
  await expect(source).toBeVisible()
  await source.selectOption({ index: 1 })
  await target.selectOption({ index: 2 })
  console.log(
    `[ic49] merging "${await source.locator('option:checked').innerText()}" into "${await target.locator('option:checked').innerText()}"`
  )

  await dialog.getByRole('button', { name: 'Merge', exact: true }).click()

  // The losing name is still readable — as an alias on the row it now resolves to.
  const alias = dialog.locator('[data-slot="journal-alias"]')
  await expect(alias.first()).toBeVisible({ timeout: 30_000 })
  console.log(
    `[ic49] after the merge the alias row reads: "${(await alias.first().innerText()).replace(/\s+/g, ' ').trim()}"`
  )
  // And the app itself reports where the merge went, rather than a bare "done".
  await expect(dialog.getByText(/now resolves here/i)).toBeVisible()
  console.log('[ic49] the done copy names where the merged name now resolves')
})
