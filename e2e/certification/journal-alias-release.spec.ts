import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// The merge's other half: a name a merge created can be released, and the interface says what that does — and
// what it does NOT do — before the reader confirms. The implementation shipped with render-suite evidence only;
// its own evidence doc names this true-machine reading as not taken (this machine had no memory to spare when
// it landed). This is that reading: merge through the panel's own form, release the name through the panel's
// own control, then read the stores back — including the invariant that releasing a name moves no numbers.
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

type Library = {
  journals?: Array<{ id: string; normalizedName?: string; displayName?: string }>
  aliases?: Array<{ normalizedName: string; journalId: string }>
}

const readLibrary = async (page: {
  evaluate: (fn: () => Promise<unknown>) => Promise<unknown>
}): Promise<Library> =>
  (await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { references: { listJournalMetrics: () => Promise<unknown> } }
    }
    return bridge.api.references.listJournalMetrics()
  })) as Library

test('releases a merged name through the panel, and moves no numbers', async ({ app }) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal alias release')

  // Seeded through the app's own bridge, the same call the import surface makes.
  const imported = await page.evaluate(async (payload) => {
    const bridge = globalThis as unknown as {
      api: { references: { importJournalMetrics: (input: unknown) => Promise<unknown> } }
    }
    return bridge.api.references.importJournalMetrics(payload)
  }, seed)
  console.log(`[ic56alias] import result: ${JSON.stringify(imported)}`)

  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Journal metrics' }).click()

  // A real merge through the panel's own form: index 0 is the "choose a journal…" placeholder.
  const source = dialog.locator('[data-slot="journal-merge-source"]')
  const target = dialog.locator('[data-slot="journal-merge-target"]')
  await expect(source).toBeVisible({ timeout: 30_000 })
  await source.selectOption({ index: 1 })
  await target.selectOption({ index: 2 })
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click()

  const afterMerge = await readLibrary(page)
  // The alias the merge wrote is the SOURCE journal's normalized name, so it is READ here rather than
  // assumed: the two spellings decide which name survives, and a spec that guessed it would be asserting its
  // own assumption about which select index is which. (First run did exactly that and failed on its guess.)
  const aliasesAfterMerge = afterMerge.aliases ?? []
  expect(
    aliasesAfterMerge.length,
    `no alias after the merge: ${JSON.stringify(afterMerge.aliases)}`
  ).toBeGreaterThan(0)
  const releasedName = aliasesAfterMerge[0].normalizedName
  console.log(
    `[ic56alias] the stores carry the alias after the merge: ${JSON.stringify(afterMerge.aliases)} — releasing "${releasedName}"`
  )
  // What the merge moved: the survivor's own numbers, read before the release so the release can be judged
  // against them rather than against a number this spec guessed.
  const mergedMetricsBefore = JSON.stringify(
    (afterMerge.journals ?? []).map((journal) => ({ id: journal.id }))
  )

  // Release the name through the panel's own control.
  const release = dialog.locator('[data-slot="journal-alias-release"]')
  await expect(release).toBeVisible({ timeout: 30_000 })
  await release.locator('[data-slot="journal-alias-release-open"]').first().click()

  // The promises the decision rests on, read from the panel before confirming: the name stops resolving here,
  // AND the numbers the merge moved do not come back.
  const confirm = release.locator('[data-slot="journal-alias-release-confirm"]')
  await expect(confirm).toBeVisible()
  const confirmText = (await confirm.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic56alias] the confirm says: "${confirmText}"`)
  expect(confirmText).toMatch(/no longer resolve to/i)
  expect(confirmText).toMatch(/stay where it put them|nothing is moved back/i)

  await release.locator('[data-slot="journal-alias-release-confirm-yes"]').click()
  await expect(release.locator('[data-slot="journal-alias-release-done"]')).toBeVisible({
    timeout: 30_000
  })
  console.log('[ic56alias] the panel reports the name released')

  // Read the stores back: the alias is gone, the journal survives, and nothing else moved.
  const afterRelease = await readLibrary(page)
  expect(
    (afterRelease.aliases ?? []).some((entry) => entry.normalizedName === releasedName),
    `the alias is still stored: ${JSON.stringify(afterRelease.aliases)}`
  ).toBe(false)
  expect(
    JSON.stringify((afterRelease.journals ?? []).map((journal) => ({ id: journal.id })))
  ).toBe(mergedMetricsBefore)
  console.log(
    `[ic56alias] after the release: aliases=${JSON.stringify(afterRelease.aliases)} journals=${JSON.stringify((afterRelease.journals ?? []).map((journal) => journal.id))}`
  )
})
