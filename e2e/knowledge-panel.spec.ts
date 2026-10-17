import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

// The window surface, exercised the way a reader uses it: open Settings, register a real file from a real path,
// then search it. The digests asserted below are computed here, in the test process, from the bytes on disk — so a
// panel that printed a digest it invented would fail rather than look plausible.
const LINE = 'TP53 amplification was observed in 12 of 40 samples'

test('registers a source and searches it from the Knowledge panel', async ({ app }) => {
  test.setTimeout(180_000)
  const page = await app.completeOnboarding()

  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot
  })
  const folder = join(dataRoot, 'knowledge-panel')
  await mkdir(folder, { recursive: true })
  const notePath = join(folder, 'cohort.md')
  const body = `# Cohort\n${LINE}\nEGFR remained wild type\n`
  await writeFile(notePath, body, 'utf8')

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click()

  const panel = page.getByRole('heading', { name: 'Knowledge', exact: true }).last()
  await expect(panel).toBeVisible()

  // Register.
  await page.getByLabel('Source location').fill(notePath)
  await page.getByRole('button', { name: 'Register', exact: true }).click()

  const sourceRow = page.getByText('cohort.md', { exact: true })
  await expect(sourceRow).toBeVisible({ timeout: 30_000 })
  // The digest of the whole file, recomputed here.
  const fileDigest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
  await expect(page.getByText(new RegExp(fileDigest), { exact: false })).toBeVisible()

  // Search.
  await page.getByLabel('Search query').fill('TP53')
  await page.getByRole('button', { name: 'Search', exact: true }).click()

  const lineDigest = createHash('sha256').update(LINE, 'utf8').digest('hex').slice(0, 12)
  await expect(page.getByText(new RegExp(lineDigest), { exact: false })).toBeVisible({
    timeout: 30_000
  })
  // The citation's location is on screen, down to the line range.
  await expect(page.getByText(`${notePath}:2-2`, { exact: false })).toBeVisible()
})
