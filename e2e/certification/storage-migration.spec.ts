import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

// The exact shape an older build produced: manifest bytes on disk under a name that is NOT their content
// hash, plus a Notebook run record pointing at the content checksum. Validation used to look manifests up
// by filename, so this evidence made the data root unmovable.
const seedStaleManifest = (dataRoot: string): void => {
  const manifest = JSON.stringify({ schemaVersion: 1, environmentName: 'legacy-python' })
  const manifestChecksum = createHash('sha256').update(manifest).digest('hex')
  const manifestDirectory = join(dataRoot, 'runtime', 'provenance', 'environment-manifests')
  mkdirSync(manifestDirectory, { recursive: true })
  writeFileSync(join(manifestDirectory, `${'0'.repeat(64)}.json`), manifest)
  const runDirectory = join(dataRoot, 'notebooks', 'legacy-project', 'legacy-session')
  mkdirSync(runDirectory, { recursive: true })
  writeFileSync(
    join(runDirectory, 'run.json'),
    JSON.stringify({
      version: 1,
      projectName: 'legacy-project',
      sessionId: 'legacy-session',
      runs: [
        {
          runId: 'legacy-run-1',
          environmentCapture: { state: 'available', manifestChecksum },
          environmentManifestChecksum: manifestChecksum
        }
      ]
    })
  )
}

test('stages a verified data-root move and recovers on discard', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Storage migration evidence')
  await sendPrompt(page, 'Persist the migration fixture.', 'Deterministic reply:')

  const parent = await app.createTestDirectory('migration-target')
  const result = await page.evaluate(async (targetParent) => {
    const bridge = globalThis as unknown as {
      api: {
        storage: {
          discardMigratedCopy: (path: string) => Promise<void>
          inspectDataRoot: (path: string) => Promise<{ kind: string }>
          migrate: (
            path: string
          ) => Promise<{ ok: boolean; error?: string; staleEvidence?: { kind: string }[] }>
        }
      }
    }
    const migration = await bridge.api.storage.migrate(targetParent)
    const staged = await bridge.api.storage.inspectDataRoot(targetParent)
    await bridge.api.storage.discardMigratedCopy(targetParent)
    const discarded = await bridge.api.storage.inspectDataRoot(targetParent)
    return { migration, staged, discarded }
  }, parent)

  expect(result.migration).toEqual({ ok: true })
  // Negative control for the stale-evidence channel: a root this build wrote itself reports none, which is
  // what keeps the dialog's note away in the ordinary move.
  expect(result.migration.staleEvidence).toBeUndefined()
  expect(result.staged.kind).toBe('invalid')
  expect(result.discarded.kind).toBe('move')

  page = await app.restart()
  await openRecentSession(page, 'Persist the migration fixture.')
})

test('moves the data root when an older build left a manifest whose name is not its content hash', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Stale manifest evidence')
  await sendPrompt(page, 'Persist the stale-manifest fixture.', 'Deterministic reply:')

  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot
  })

  seedStaleManifest(dataRoot)

  const parent = await app.createTestDirectory('migration-target-stale')
  const result = await page.evaluate(async (targetParent) => {
    const bridge = globalThis as unknown as {
      api: {
        storage: {
          discardMigratedCopy: (path: string) => Promise<void>
          migrate: (
            path: string
          ) => Promise<{ ok: boolean; error?: string; staleEvidence?: { kind: string }[] }>
        }
      }
    }
    const migration = await bridge.api.storage.migrate(targetParent)
    await bridge.api.storage.discardMigratedCopy(targetParent)
    return migration
  }, parent)

  expect(result.error).toBeUndefined()
  expect(result.ok).toBe(true)
  // Reported, not fatal: the move completes and the stale name travels to the UI instead of blocking it.
  expect(result.staleEvidence?.some((entry) => entry.kind === 'manifest-name-mismatch')).toBe(true)
})

// The same scenario through the real entry points. The bridge-level case above proves what main returns;
// this one proves a user can see it: rail → Settings → Storage → folder field → “Change location” → the move
// dialog ends on the note naming how many entries skipped re-validation.
test('shows the stale-evidence note in the move dialog an older manifest would otherwise block', async ({
  app
}) => {
  test.setTimeout(240_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Stale manifest dialog evidence')
  await sendPrompt(page, 'Persist the stale-manifest dialog fixture.', 'Deterministic reply:')

  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot
  })

  seedStaleManifest(dataRoot)

  const parent = await app.createTestDirectory('migration-target-stale-ui')

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Storage', exact: true }).click()
  // The panel keeps its folder editor behind a warning dialog (“Change location” → “Continue”); the editor
  // then carries its own same-named button that actually starts the move.
  await page.getByRole('button', { name: 'Change location' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('#data-dir-path-input').fill(parent)
  await page.getByRole('button', { name: 'Change location' }).click()

  // A session that is still running turns the dialog into the interrupt confirmation first; either road
  // ends on the same done stage, so wait briefly for the confirmation instead of assuming which one.
  const interrupt = page.getByRole('button', { name: 'Interrupt and move' })
  const needsConfirmation = await interrupt
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (needsConfirmation) await interrupt.click()

  const note = page.getByTestId('stale-evidence-note')
  await expect(note).toBeVisible({ timeout: 90_000 })
  await expect(note).toContainText(
    'Older environment manifests were kept as-is and not re-validated.'
  )
  // The count renders after the sentence; assert its shape rather than pinning a number the fixture does
  // not own, so any extra evidence the app legitimately reports cannot fail this.
  await expect(note).toHaveText(/not re-validated\.\s*\d+\s*$/)

  await page.evaluate(async (targetParent) => {
    const bridge = globalThis as unknown as {
      api: { storage: { discardMigratedCopy: (path: string) => Promise<void> } }
    }
    await bridge.api.storage.discardMigratedCopy(targetParent)
  }, parent)

  page = await app.restart()
  await openRecentSession(page, 'Persist the stale-manifest dialog fixture.')
})
