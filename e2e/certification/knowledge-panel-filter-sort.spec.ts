import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// Narrowing and reordering the source list, read from a real window against a real data root.
//
// The three files are deliberately named so that alphabetical order and size order disagree: a sort control
// that only re-rendered the same list would still show the register order, and the row order asserted below
// would come out wrong. Sizes are real bytes the product fingerprints when it registers them.
const SMALL = 'alpha-small.md'
const MEDIUM = 'beta-medium.md'
const LARGE = 'gamma-large.md'
const BODIES: Array<[string, string]> = [
  [SMALL, `# ${SMALL}\nshort\n`],
  [MEDIUM, `# ${MEDIUM}\n${'medium line\n'.repeat(40)}`],
  [LARGE, `# ${LARGE}\n${'large line\n'.repeat(400)}`]
]

test('filters and reorders the source list in a real window', async ({ app }) => {
  test.setTimeout(240_000)
  const page = await app.completeOnboarding()

  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot
  })
  const folder = join(dataRoot, 'knowledge-sort')
  await mkdir(folder, { recursive: true })
  for (const [name, body] of BODIES) {
    await writeFile(join(folder, name), body, 'utf8')
  }

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true }).last()).toBeVisible()

  await page.getByLabel('Source kind').selectOption('file')
  for (const [name] of BODIES) {
    await page.getByLabel('Source location').fill(join(folder, name))
    await page.getByRole('button', { name: 'Register', exact: true }).click()
    await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 30_000 })
  }

  const rows = page.locator('[data-testid="knowledge-source-list"] li span.font-medium')
  // Register order, and no count line because nothing is narrowed yet.
  await expect(rows).toHaveText([SMALL, MEDIUM, LARGE])
  await expect(page.getByTestId('knowledge-filter-count')).toHaveCount(0)

  // Narrow by text: one row stays, and the panel says how much of the register it is showing.
  await page.getByLabel('Filter sources').fill('beta')
  await expect(rows).toHaveText([MEDIUM])
  await expect(page.getByTestId('knowledge-filter-count')).toHaveText('Showing 1 of 3')
  await expect(page.getByText(SMALL, { exact: true })).toHaveCount(0)

  // Clear the text, narrow by kind instead: every source here is a file, so a URL filter matches nothing —
  // and the panel must say that rather than claim the register is empty.
  await page.getByLabel('Filter sources').fill('')
  await page.getByLabel('Filter by kind').selectOption('url')
  await expect(page.getByTestId('knowledge-no-matches')).toHaveText('No sources match this filter.')
  await expect(page.getByText('No sources registered yet.', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('knowledge-filter-count')).toHaveText('Showing 0 of 3')

  // Widen again and sort by size: largest first, which is the reverse of the register order here.
  await page.getByLabel('Filter by kind').selectOption('all')
  await page.getByLabel('Sort').selectOption('bytes')
  await expect(rows).toHaveText([LARGE, MEDIUM, SMALL])
  await expect(page.getByTestId('knowledge-filter-count')).toHaveCount(0)

  // Back to register order, and back to what the store returned.
  await page.getByLabel('Sort').selectOption('store')
  await expect(rows).toHaveText([SMALL, MEDIUM, LARGE])
})
