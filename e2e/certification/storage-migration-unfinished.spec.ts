import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// IC12: a copy staged before a restart must be resolvable by the session that finds it. The marker beside
// the folder is the surviving state (source → target → token), so both actions the dialog offers —
// finish and discard — have to be reachable from a process that never staged the copy itself.
//
// The fixture is the app's own staging: migrate() copies and leaves a verified marker, and no commit
// follows. The restart is what makes this the crash case rather than a same-session one.
const MIGRATION_MARKER = '.purescience-migration.json'

type StagedProbe = {
  migrate: { ok: boolean; error?: string }
  inspected: { kind: string; unfinishedMove?: { status: string }; dataRoot: string }
}

const stageUncommittedMove = async (
  page: import('playwright').Page,
  parent: string
): Promise<StagedProbe> =>
  page.evaluate(async (targetParent) => {
    const bridge = globalThis as unknown as {
      api: {
        storage: {
          migrate: (path: string) => Promise<{ ok: boolean; error?: string }>
          inspectDataRoot: (path: string) => Promise<{
            kind: string
            unfinishedMove?: { status: string }
            dataRoot: string
          }>
        }
      }
    }
    const migrate = await bridge.api.storage.migrate(targetParent)
    const inspected = await bridge.api.storage.inspectDataRoot(targetParent)
    return { migrate, inspected }
  }, parent)

// Settings → Storage → the folder field → "Change location" opens the move dialog on this target. A
// session that is still running turns it into the interrupt confirmation first, so accept either road.
const openMoveDialog = async (page: import('playwright').Page, parent: string): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Storage', exact: true }).click()
  await page.getByRole('button', { name: 'Change location' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('#data-dir-path-input').fill(parent)
  // The editor's own button: its label depends on what the folder holds ('Change location' for an empty
  // one, 'Continue' when the folder carries an unfinished move), so the spec keys off its testid.
  await page.getByTestId('storage-change-location').click()

  const interrupt = page.getByRole('button', { name: 'Interrupt and move' })
  const needsConfirmation = await interrupt
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (needsConfirmation) await interrupt.click()
}

test('finishes an unfinished data move a previous process left behind', async ({ app }) => {
  test.setTimeout(300_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Unfinished move: finish')
  await sendPrompt(page, 'Persist the unfinished-move fixture.', 'Deterministic reply:')

  const parent = await app.createTestDirectory('unfinished-move-finish')
  const staged = await stageUncommittedMove(page, parent)
  expect(staged.migrate.ok, `migrate said ${JSON.stringify(staged.migrate)}`).toBe(true)
  // The classification is still 'invalid' (never adoptable) but it names the move's own state.
  expect(staged.inspected.kind).toBe('invalid')
  expect(staged.inspected.unfinishedMove).toEqual({ status: 'verified' })
  const stagedRoot = staged.inspected.dataRoot

  page = await app.restart()

  await openMoveDialog(page, parent)

  // The dialog offers the unfinished move — with the two actions — instead of the dead-end sentence.
  await expect(page.getByTestId('migration-unfinished')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('migration-unfinished-finish')).toBeVisible()
  await expect(page.getByTestId('migration-unfinished-discard')).toBeVisible()

  await page.getByTestId('migration-unfinished-finish').click()

  // Finishing switches the root (and relaunches, so the effect is read from disk): a migrated directory
  // is now at the staged root — whose name the app reported, not one guessed here (`PureScience-DEV` in
  // this build, and `sessions/` is NOT part of a move: it lives in the config root) — and the marker is
  // gone. The marker's presence is asserted first, so its absence afterwards is a reading, not a guess.
  expect(existsSync(join(stagedRoot, MIGRATION_MARKER))).toBe(true)
  await expect
    .poll(async () => existsSync(join(stagedRoot, 'workspaces')), {
      timeout: 120_000,
      intervals: [1_000]
    })
    .toBe(true)
  await expect
    .poll(async () => existsSync(join(stagedRoot, MIGRATION_MARKER)), {
      timeout: 60_000,
      intervals: [1_000]
    })
    .toBe(false)
})

test('discards an unfinished data move a previous process left behind', async ({ app }) => {
  test.setTimeout(300_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Unfinished move: discard')
  await sendPrompt(page, 'Persist the discard fixture.', 'Deterministic reply:')

  const parent = await app.createTestDirectory('unfinished-move-discard')
  const staged = await stageUncommittedMove(page, parent)
  expect(staged.migrate.ok, `migrate said ${JSON.stringify(staged.migrate)}`).toBe(true)
  expect(staged.inspected.unfinishedMove).toEqual({ status: 'verified' })
  const stagedRoot = staged.inspected.dataRoot
  // The marker is present now, so the absence asserted after the discard is a reading rather than a
  // vacuous pass on a path that never held anything.
  expect(existsSync(join(stagedRoot, MIGRATION_MARKER))).toBe(true)

  page = await app.restart()

  await openMoveDialog(page, parent)

  await expect(page.getByTestId('migration-unfinished')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('migration-unfinished-discard').click()

  // Discarding removes the staged copy and leaves the app where it was: the target reads as an ordinary
  // empty folder again (kind 'move'), with no marker and no relaunch.
  await expect
    .poll(
      async () =>
        page.evaluate(async (targetParent) => {
          const bridge = globalThis as unknown as {
            api: { storage: { inspectDataRoot: (path: string) => Promise<{ kind: string }> } }
          }
          return (await bridge.api.storage.inspectDataRoot(targetParent)).kind
        }, parent),
      { timeout: 90_000, intervals: [1_000] }
    )
    .toBe('move')
  expect(existsSync(join(stagedRoot, MIGRATION_MARKER))).toBe(false)
})
