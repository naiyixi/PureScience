import { createHash } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// Sweeping away the copies no source names any more, read from a real window against a real data root.
//
// The reading is built so that the panel's own sentence cannot be the evidence: a copy is planted on disk whose
// digest nothing references, and the assertion after the click is made by THIS process reading
// `<dataRoot>/knowledge/contents` — the sweep has to have removed the orphan and left the copy a registered URL
// source still names. The registered body comes from a real local HTTP server, so the kept copy is one the
// product itself wrote while answering a real request, not one this test wrote.
const KEPT_BODY =
  'Sweeping is only worth doing if the bytes that stay are the ones somebody named.\n'
const ORPHAN_BODY = 'Nobody references these bytes any more.\n'

const digestOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

test('sweeps the copies no source names and keeps the one a source still names', async ({
  app
}) => {
  test.setTimeout(240_000)
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
    const kept = digestOf(KEPT_BODY)
    const orphan = digestOf(ORPHAN_BODY)
    // Plant the orphan before anything is registered: it stands for the copy a register left behind when it died
    // between writing the bytes and committing the row.
    await mkdir(contents, { recursive: true })
    await writeFile(join(contents, orphan), ORPHAN_BODY, 'utf8')

    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Knowledge', exact: true }).last()).toBeVisible()

    await page.getByLabel('Source kind').selectOption('url')
    await page.getByLabel('Source location').fill(`http://127.0.0.1:${port}/cohort`)
    await page.getByRole('button', { name: 'Register', exact: true }).click()
    // The panel prints the digest the store computed; the same digest is computed here from the body the server
    // served, so the two agreeing means the copy on disk is these exact bytes.
    await expect(page.getByText(new RegExp(kept.slice(0, 12)))).toBeVisible({ timeout: 30_000 })
    expect((await readdir(contents)).sort()).toEqual([kept, orphan].sort())

    await page.getByRole('button', { name: 'Clean unused copies' }).click()

    const freed = Buffer.byteLength(ORPHAN_BODY, 'utf8')
    await expect(page.getByText(`Deleted 1 unused copy(ies), freed ${freed} byte(s).`)).toBeVisible(
      { timeout: 30_000 }
    )
    // The disk, read by this process: the orphan is gone and the named copy is still there.
    expect(await readdir(contents)).toEqual([kept])
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
})
