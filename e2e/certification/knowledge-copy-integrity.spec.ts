import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// A stored copy is named by the digest of its own bytes. That name is a claim, and this spec is about what happens
// when the bytes stop matching it — the case an in-place edit or a restore from another machine produces.
//
// Two readings, both from a real window against a real data root, and neither of them the panel's own sentence:
//
//   1. SEARCH: the tampered copy must not answer. The words in it appear nowhere in the page the server serves, so a
//      single hit would mean the product quoted bytes the source's fingerprint never covered. The assertion is that
//      there is no such hit, and that the copy on disk is the page's own bytes again (the reader healed the name).
//   2. SWEEP: a tampered copy is deleted and reported in its own sentence, apart from "unused copies". After the
//      click this process reads `<dataRoot>/knowledge/contents` itself.
//
// The registered body comes from a real local HTTP server, so the copy the product reads was written by the product
// while answering a real request — not planted by this test and then read back as if it proved something.
const KEPT_BODY =
  'Verification runs against the live page; search runs against the stored copy, which is brackish.\n'
const POISON_BODY = 'Zanzibar appears only in bytes that were edited on disk.\n'

const digestOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

test('refuses to answer from a copy whose bytes were edited, and sweeps it away', async ({
  app
}) => {
  test.setTimeout(300_000)
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(KEPT_BODY)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as { port: number }
  try {
    const page = await app.completeOnboarding()
    const dataRoot = await page.evaluate(async () => {
      const bridge = globalThis as unknown as {
        api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
      }
      return (await bridge.api.storage.getInfo()).dataRoot
    })
    const contents = join(dataRoot, 'knowledge', 'contents')
    const copyPath = join(contents, digestOf(KEPT_BODY))

    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Knowledge', exact: true }).last()).toBeVisible()

    await page.getByLabel('Source kind').selectOption('url')
    await page.getByLabel('Source location').fill(`http://127.0.0.1:${port}/cohort`)
    await page.getByRole('button', { name: 'Register', exact: true }).click()
    await expect(page.getByText(new RegExp(digestOf(KEPT_BODY).slice(0, 12)))).toBeVisible({
      timeout: 30_000
    })
    // The product wrote the copy while answering the request; this is that file, read by this process.
    expect(await readFile(copyPath, 'utf8')).toBe(KEPT_BODY)

    // 1. SEARCH refuses the edited copy.
    await writeFile(copyPath, POISON_BODY, 'utf8')
    await page.getByLabel('Search query').fill('Zanzibar')
    await page.getByRole('button', { name: 'Search', exact: true }).click()

    await expect(page.getByText('No matches in the registered sources.')).toBeVisible({
      timeout: 30_000
    })
    // Not "pending": the name was healed from the page itself, so the source was indexed — from its own bytes,
    // where the poisoned word does not appear. `no-matches` with zero pending is the honest reading of that.
    await expect(page.getByText('status no-matches · indexed 1 · pending 0')).toBeVisible({
      timeout: 30_000
    })
    expect(await readFile(copyPath, 'utf8')).toBe(KEPT_BODY)

    // 2. SWEEP deletes what does not match, and says so in its own words.
    await writeFile(copyPath, POISON_BODY, 'utf8')
    await page.getByRole('button', { name: 'Clean unused copies' }).click()

    await expect(
      page.getByText('1 copy(ies) no longer matched their own digest and were deleted.')
    ).toBeVisible({ timeout: 30_000 })
    // Nothing was "unused": the sentence that reports ordinary housekeeping must not appear beside this deletion.
    await expect(page.getByText('No unused copies to delete.')).toHaveCount(0)
    expect(await readdir(contents)).toEqual([])

    // And the source is still answerable afterwards: the next query heals the name from the page.
    await page.getByLabel('Search query').fill('brackish')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByText('status ok · indexed 1 · pending 0')).toBeVisible({
      timeout: 30_000
    })
    await expect(page.getByText('No matches in the registered sources.')).toHaveCount(0)
    expect(await readFile(copyPath, 'utf8')).toBe(KEPT_BODY)
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
})
