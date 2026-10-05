import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC34 real-window acceptance, and what it can and cannot prove here.
//
// The fix: the data-location section used to render a failed `storage.getInfo()` as "Loading" forever, because
// the read had no rejection handler — which also disabled the only entry to the move flow. It now has three
// states, a retry, and a gate that only offers the move entry when the information is actually known.
//
// WHAT THIS FILE PROVES ON A REAL WINDOW: that a genuinely bad data root does not break the section — the app
// is restarted with settings.dataRoot pointing at a directory whose mode forbids traversal, and the section
// still renders the root and keeps the move entry available. The recovery half is exercised for real too: the
// root is repaired on disk and the section is re-mounted, which is a real IPC re-read of the repaired path.
//
// WHAT IT CANNOT PROVE HERE — and this is a finding, not a gap to paper over: the ERROR state is unreachable
// from the main side in this build. `storage.getInfo()` guards every fallible call inside it (available bytes,
// the settings/status block) and the one unguarded await it has — the usage walk — degrades internally, so an
// unreadable, missing or otherwise hostile data root still yields a successful answer (measured below: `ok`).
// A renderer-side override cannot reach it either: the bridge object is frozen (also measured below: the
// override does not take). Reaching the state would take a main-process fault or a channel failure, which a spec
// cannot induce. The error-and-retry path therefore has render-suite evidence
// (`StoragePanel.render.test.tsx`: a rejected read is named, the move entry is withheld, and a succeeding retry
// returns to the real content) rather than a real-machine reading, and it is labelled as such.
test.setTimeout(180_000)

test('a hostile data root keeps the section usable, and a repaired one is re-read for real', async ({
  app
}) => {
  await app.completeOnboarding()

  const dataRoot = join(app.storageRoot, 'unreadable-root')
  rmSync(dataRoot, { recursive: true, force: true })
  mkdirSync(dataRoot, { recursive: true })
  chmodSync(dataRoot, 0o000)

  const settingsPath = join(app.storageRoot, 'settings.json')
  const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  raw.dataRoot = dataRoot
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2))

  const reopened = await app.restart()
  await expect(reopened.getByRole('button', { name: 'Settings' }).first()).toBeVisible({
    timeout: 60_000
  })

  // The main side refuses to fail on a hostile root — recorded, because it is why the error state cannot be
  // reached from here.
  const withBadRoot = await reopened.evaluate(async (): Promise<string> => {
    try {
      const info = await window.api.storage.getInfo()
      return `ok: ${String((info as { dataRoot?: string } | undefined)?.dataRoot ?? '')}`
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`
    }
  })
  console.log(`[ic34] getInfo() with an unreadable data root: ${withBadRoot}`)

  // And the frozen bridge is why a renderer-side override cannot stand in for that fault.
  const overrideTaken = await reopened.evaluate((): string => {
    const api = window.api as unknown as { storage: { getInfo: () => Promise<unknown> } }
    const original = api.storage.getInfo
    try {
      api.storage.getInfo = () => Promise.reject(new Error('ic34: induced read failure'))
    } catch {
      return 'no — the assignment threw (frozen object)'
    }
    const changed = api.storage.getInfo !== original
    api.storage.getInfo = original
    return changed ? 'yes' : 'no — the assignment was silently ignored (frozen object)'
  })
  console.log(`[ic34] can the renderer override the bridge? ${overrideTaken}`)

  // The section is still usable with the hostile root: it renders, and the move entry stays available.
  await reopened.getByRole('button', { name: 'Settings' }).first().click()
  const settings = reopened.getByRole('dialog', { name: 'Settings' })
  const openStorage = async (): Promise<void> => {
    await settings
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: /Storage/i })
      .click()
  }
  await openStorage()
  const path = settings.locator('pre[aria-label]').first()
  await expect(path).toBeVisible({ timeout: 60_000 })
  const shown = (await path.innerText()).trim()
  console.log(`[ic34] the section shows while the root is unreadable: "${shown}"`)
  expect(shown).toBe(dataRoot)
  await expect(settings.getByRole('button', { name: 'Change location' })).toBeVisible()
  console.log('[ic34] the move entry is available even with an unreadable root')

  // Now repair the root on disk and re-mount the section: this is a real IPC re-read of the repaired path.
  chmodSync(dataRoot, 0o755)
  await settings.getByRole('button', { name: 'General' }).first().click()
  await openStorage()
  await expect(path).toBeVisible({ timeout: 60_000 })
  const afterRepair = (await path.innerText()).trim()
  console.log(`[ic34] the path the section reads after the root is repaired: "${afterRepair}"`)
  expect(afterRepair).toBe(dataRoot)
})
