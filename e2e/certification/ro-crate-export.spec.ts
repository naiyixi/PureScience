import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { test } from '../fixtures/electron-app'
import {
  RO_CRATE_CONTEXT_URL,
  failedRoCrateAssertions,
  validateRoCrate,
  type RoCrateMetadataDocument,
  type RoCrateValidationReport
} from '../../src/shared/ro-crate'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the RO-Crate export channel, on a real window, over the real IPC boundary.
//
// The unit suites already prove the crate builder and the writer. What they cannot prove is the part a
// person actually takes: that a project they are looking at can be exported from the interface, and that
// the file which lands on disk is a crate that VALIDATES. So this spec never trusts the panel — it reads
// `ro-crate-metadata.json` back off the filesystem, re-hashes the payload bytes itself, and re-runs the
// RO-Crate assertions against what is really there. The only seam replaced is the native save dialogue,
// because no test can operate one.

test.setTimeout(240_000)

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const readCrate = async (
  crateDir: string
): Promise<{
  document: Record<string, unknown>
  report: RoCrateValidationReport
  payloadPaths: string[]
}> => {
  const document = JSON.parse(
    await readFile(join(crateDir, 'ro-crate-metadata.json'), 'utf8')
  ) as Record<string, unknown>

  const files = await readdir(join(crateDir, 'files'))
  const payloadPaths = files.map((name) => `files/${name}`)
  const payloadDigests = new Map(
    await Promise.all(
      payloadPaths.map(async (path) => {
        const bytes = await readFile(join(crateDir, path))
        return [path, { sizeBytes: bytes.byteLength, sha256: sha256(bytes) }] as const
      })
    )
  )

  // Assertions against the bytes that are really on disk, not against the writer's own report.
  return {
    document,
    payloadPaths,
    report: validateRoCrate({
      document: document as unknown as RoCrateMetadataDocument,
      payloadPaths,
      payloadDigests
    })
  }
}

test('exports a project from the interface into a crate that validates on disk', async ({
  app
}, testInfo) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  const projectId = await createProject(page, 'RO-Crate export evidence')
  // The fake agent publishes one durable Artifact Version for the prompt below and names its identity in
  // the receipt, which is what gives the crate something with real provenance to describe.
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )

  const exportDir = await app.createTestDirectory('ro-crate-export')
  const crateDir = join(exportDir, 'crate')
  // The destination the save dialogue would have returned. The dialogue is the one native seam a test
  // cannot drive; every step after it — IPC, the read of the durable layout, the copy, the write of the
  // metadata, the self-validation — is the real code path.
  await app.stubSaveDialog(crateDir)

  // The project's own menu is where a person exports it from.
  await page.getByRole('button', { name: 'Switch project' }).click()
  await page.getByTestId('export-ro-crate').click()

  const dialog = page.getByRole('dialog', { name: 'Export project as RO-Crate' })
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('ro-crate-export-submit').click()

  // What this surface does with a crate from elsewhere is stated up front: it can be CHECKED here,
  // read-only, and it is never imported into a project. Saying it is the difference between a
  // limitation and a mystery — and the entry below is what makes the sentence true.
  await expect(dialog.locator('[data-slot="ro-crate-export-only"]')).toContainText(
    'A crate from elsewhere can also be checked here, read-only, and is never imported into a project.'
  )
  console.log('[ic48] the dialog states what it does with a crate from elsewhere')

  // The panel reports a result a person can check: how many files, where, and the validation verdict.
  const result = dialog.getByTestId('ro-crate-export-result')
  await expect(result).toBeVisible({ timeout: 60_000 })
  await expect(dialog.getByTestId('ro-crate-export-validation')).toContainText(
    'RO-Crate verification passed'
  )
  await expect(result).toContainText(crateDir)
  // The fake agent published exactly one Version, so the crate describes at least that one file.
  await expect(result).toContainText('Wrote 1 files to')

  // --- and now the part that matters: what is actually on disk -------------------------------
  expect((await stat(join(crateDir, 'ro-crate-metadata.json'))).size).toBeGreaterThan(0)
  const { document, payloadPaths, report } = await readCrate(crateDir)

  expect(payloadPaths).toEqual(['files/provenance-evidence.txt'])
  // The bytes are the stored Version's, verbatim.
  expect(await readFile(join(crateDir, 'files/provenance-evidence.txt'), 'utf8')).toBe(
    'artifact provenance e2e'
  )
  // Every spec-must and export-contract assertion holds for the file that was written — 30 of them, none
  // failed. A crate that does not validate is not a deliverable, so this is the acceptance criterion.
  expect(report.failed).toBe(0)
  expect(report.ok).toBe(true)
  expect(report.passed).toBe(30)

  const graph = document['@graph'] as Array<Record<string, unknown>>
  const root = graph.find((entity) => entity['@id'] === './')
  expect(root?.['@type']).toBe('Dataset')
  expect(root?.['identifier']).toBe(projectId)
  expect(root?.['hasPart']).toEqual([{ '@id': 'files/provenance-evidence.txt' }])
  const payload = graph.find((entity) => entity['@id'] === 'files/provenance-evidence.txt')
  expect(payload?.['@type']).toBe('File')
  expect(payload?.['sha256']).toBe(sha256(Buffer.from('artifact provenance e2e')))
  // The provenance the app recorded is named, so the copy can be traced back to its Version.
  expect(String(payload?.['identifier'])).toMatch(/^artifact-version:/)

  // --- the same panel's read-only half, on crates this app did NOT write ----------------------
  // The sentence above promises an external crate can be checked here. Two are put through it: the
  // crate this run just wrote (which the writer itself judged clean), and one whose metadata is
  // deliberately broken — where the point is that the failing RULE is named, not that it says "no".
  const metadataBefore = await readFile(join(crateDir, 'ro-crate-metadata.json'))

  const cratePathField = dialog.locator('[data-slot="ro-crate-inspect-path"]')
  await cratePathField.fill(crateDir)
  await dialog.getByTestId('ro-crate-inspect-submit').click()

  // ① the app's own crate, read back through the foreign-crate path.
  await expect(dialog.getByTestId('ro-crate-inspect-all-passed')).toBeVisible({ timeout: 30_000 })
  await expect(dialog.getByTestId('ro-crate-inspect-summary')).toContainText('0 not met')
  await expect(dialog.getByTestId('ro-crate-inspect-metadata-path')).toContainText(
    join(crateDir, 'ro-crate-metadata.json')
  )
  console.log('[ic48] the read-only half judged this run’s own crate clean')

  // ② a crate that breaks a MUST. The verdict expected on screen is computed from the same document
  // through the app's own rules, so the panel cannot quietly disagree with them.
  const brokenDir = join(exportDir, 'broken-crate')
  await mkdir(brokenDir, { recursive: true })
  const brokenDocument = {
    '@context': [RO_CRATE_CONTEXT_URL],
    '@graph': [{ '@id': './', '@type': 'Dataset', name: 'Not one of this app’s crates' }]
  }
  await writeFile(
    join(brokenDir, 'ro-crate-metadata.json'),
    JSON.stringify(brokenDocument, null, 2),
    'utf8'
  )
  const expectedFailures = failedRoCrateAssertions(
    validateRoCrate({ document: brokenDocument as unknown as RoCrateMetadataDocument })
  )
  expect(expectedFailures.length).toBeGreaterThan(0)

  await cratePathField.fill(brokenDir)
  await dialog.getByTestId('ro-crate-inspect-submit').click()
  const failedList = dialog.getByTestId('ro-crate-inspect-failed-list')
  await expect(failedList).toBeVisible({ timeout: 30_000 })
  const named = await failedList.locator('li').allInnerTexts()
  console.log(`[ic48] rules named on screen: ${JSON.stringify(named)}`)
  expect(named.length).toBe(expectedFailures.length)
  for (const assertion of expectedFailures) expect(named.join('\n')).toContain(assertion.id)
  // The level word is what keeps a foreign crate's author from being told their file breaks RO-Crate
  // when the rule was only this app's own expectation of the crates it writes.
  expect(named.join('\n')).toContain('required by RO-Crate 1.1')
  // A judged crate is a report, never a success: no all-passed line beside failing rules.
  await expect(dialog.getByTestId('ro-crate-inspect-all-passed')).toHaveCount(0)

  // Read-only means read-only: the crate that was checked is byte-for-byte what it was before.
  expect((await readFile(join(crateDir, 'ro-crate-metadata.json'))).equals(metadataBefore)).toBe(
    true
  )

  // --- the longest copy must not break the panel --------------------------------------------
  // Chinese is the densest dictionary here, and the success block carries a full absolute path. The
  // dialogue is closed and reopened so the same result renders in Chinese, then measured in the real
  // layout: a panel that scrolls sideways is a broken panel whatever the string says.
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Language' }).click()
  await page.getByRole('menuitem', { name: '简体中文' }).click()

  await page.getByRole('button', { name: '切换项目' }).click()
  await page.getByTestId('export-ro-crate').click()
  const chineseDialog = page.getByRole('dialog', { name: '把项目导出为 RO-Crate' })
  await expect(chineseDialog).toBeVisible()
  await expect(chineseDialog.getByTestId('ro-crate-export-validation')).toContainText(
    'RO-Crate 校验通过'
  )

  const overflow = await chineseDialog.evaluate((element) => {
    const documentElement = element.ownerDocument.documentElement
    return {
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      pageScrollWidth: documentElement.scrollWidth,
      viewportWidth: element.ownerDocument.defaultView?.innerWidth ?? documentElement.clientWidth
    }
  })
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
  expect(overflow.pageScrollWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1)

  // The export directory lives under the harness's throwaway root, so the evidence a person can inspect
  // afterwards — the crate itself, and the Chinese panel that was measured — is copied into this run's
  // output directory before the application is torn down.
  await page.screenshot({ path: testInfo.outputPath('ro-crate-export-zh.png') })
  const keptCrate = testInfo.outputPath('crate')
  await mkdir(keptCrate, { recursive: true })
  await cp(crateDir, keptCrate, { recursive: true })
})

/** Finds the one stored file the app published, wherever the durable layout put it. */
const findStoredFile = async (root: string, fileName: string): Promise<string> => {
  const walk = async (dir: string): Promise<string | undefined> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = await walk(path)
        if (found !== undefined) return found
      } else if (entry.name === fileName) {
        return path
      }
    }
    return undefined
  }
  const found = await walk(root)
  if (found === undefined) throw new Error(`${fileName} was not found under ${root}`)
  return found
}

// IC45: a refusal is not one generic sentence. The writer already says WHICH Versions it refused and why —
// their bytes no longer hash to what the record holds — and that list has to reach the person, or "every
// version was refused" leaves them with nothing to check. The tamper below is what makes it happen for
// real: the bytes are changed after publication, so the writer's own verification refuses the version.
test('names the refusal and lists every version it would not export', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'RO-Crate refusal evidence')
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )

  // The writer reads each published Version's OWN directory: `content` sits beside `evidence.json`, and the
  // refusal happens when that file's bytes no longer hash to the checksum the evidence recorded. Breaking a
  // copy elsewhere (the artifact message's file) changes nothing — the earlier attempt proved that.
  const evidenceFile = await findStoredFile(app.storageRoot, 'evidence.json')
  const stored = join(dirname(evidenceFile), 'content')
  console.log(`[ic45] the published version's content is at ${stored}`)
  await writeFile(stored, 'artifact provenance e2e — tampered after publication', 'utf8')

  const exportDir = await app.createTestDirectory('ro-crate-refusal')
  const crateDir = join(exportDir, 'crate')
  await app.stubSaveDialog(crateDir)
  await page.getByRole('button', { name: 'Switch project' }).click()
  await page.getByTestId('export-ro-crate').click()

  const dialog = page.getByRole('dialog', { name: 'Export project as RO-Crate' })
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('ro-crate-export-submit').click()

  const refusal = dialog.getByTestId('ro-crate-export-failure')
  await expect(refusal).toBeVisible({ timeout: 60_000 })
  console.log(`[ic45] the named refusal: "${(await refusal.innerText()).trim()}"`)

  // The list is the point: one row per refused Version, each naming the reason in words.
  const list = dialog.getByTestId('ro-crate-export-refused-list')
  await expect(list).toBeVisible()
  const items = await list.locator('li').allInnerTexts()
  console.log(`[ic45] refused versions on screen: ${JSON.stringify(items)}`)
  expect(items.length).toBeGreaterThan(0)
  expect(items.join(' ')).toContain('no longer hash to what was recorded')
  // A refusal is not a partial success: no result block may appear beside it.
  await expect(dialog.getByTestId('ro-crate-export-result')).toHaveCount(0)
})
