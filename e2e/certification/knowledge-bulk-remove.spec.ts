import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// Removing several registered sources in one action, read from a real window against a real data root.
//
// The evidence is deliberately not the panel's own sentence alone: after the click this process reads
// `<dataRoot>/knowledge/sources.json` and counts what is left there, and it also checks that the three probe
// files are still on disk — removing a source unregisters it, it does not delete the reader's files. A panel that
// said "removed" while the register still named the rows would pass a screen-only assertion and fail this one.
const NAMES = ['bulk-probe-a.md', 'bulk-probe-b.md', 'bulk-probe-c.md']

test('removes the ticked sources in one action and leaves the unticked one registered', async ({
  app
}) => {
  test.setTimeout(240_000)
  const page = await app.completeOnboarding()
  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot
  })

  // Real files, inside the data root (the store refuses paths outside its managed roots), so registration reads
  // bytes the product itself fingerprints.
  const probeDir = join(dataRoot, 'bulk-probe')
  await mkdir(probeDir, { recursive: true })
  for (const name of NAMES) {
    await writeFile(join(probeDir, name), `# ${name}\n\nRegistered only to be removed.\n`, 'utf8')
  }

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true }).last()).toBeVisible()

  await page.getByLabel('Source kind').selectOption('file')
  for (const name of NAMES) {
    await page.getByLabel('Source location').fill(join(probeDir, name))
    await page.getByRole('button', { name: 'Register', exact: true }).click()
    await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 30_000 })
  }

  // Two of the three, chosen by row label. The digest each row prints comes from the store, so the rows on screen
  // are the registered sources and not something this test typed.
  await page.getByLabel(`Select ${NAMES[0]}`).check()
  await page.getByLabel(`Select ${NAMES[1]}`).check()
  await expect(page.getByTestId('knowledge-bulk-bar')).toContainText('Selected 2')

  await page.getByTestId('knowledge-bulk-remove').click()
  // The first click only arms: nothing may have been removed before the confirm.
  await expect(page.getByTestId('knowledge-bulk-confirm')).toBeVisible()
  const armedRegister = JSON.parse(
    await readFile(join(dataRoot, 'knowledge', 'sources.json'), 'utf8')
  ) as { sources: unknown[] }
  expect(armedRegister.sources).toHaveLength(3)

  await page.getByTestId('knowledge-bulk-confirm').click()
  await expect(page.getByText('Removed 2 source(s); 0 stored copy(ies) pruned.')).toBeVisible({
    timeout: 30_000
  })

  // The register, read by this process: one source left, and it is the unticked one.
  const register = JSON.parse(
    await readFile(join(dataRoot, 'knowledge', 'sources.json'), 'utf8')
  ) as { sources: { location: string }[] }
  expect(register.sources).toHaveLength(1)
  expect(register.sources[0]?.location).toBe(join(probeDir, NAMES[2]))

  await expect(page.getByText(NAMES[0], { exact: true })).toHaveCount(0)
  await expect(page.getByText(NAMES[1], { exact: true })).toHaveCount(0)
  await expect(page.getByText(NAMES[2], { exact: true })).toBeVisible()
  // Unregistering is not deleting: all three files the reader pointed at are still there.
  for (const name of NAMES) {
    expect(await readFile(join(probeDir, name), 'utf8')).toContain(name)
  }
})
