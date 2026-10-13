import { expect } from '@playwright/test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// B1 (v2.1.0) — the sentence a reader is left with when the app refuses a notebook run they asked for.
//
// The refusal is thrown in main (`NotebookRunDeclinedError: Notebook run declined: fs-delete`) and the
// pane used to print whatever arrived: the transport's envelope, the engine's class name and the machine
// rule id, in English, above the terminal — at the one moment a reader most needs plain words, having
// just said no themselves. The pane now strips the envelope and re-says the refusal with the same rule
// names the approval card used, keeping the machine id inline (the receipt a third party recomputes
// names that id). This spec reads that sentence off the real window: the code is typed into the pane's
// own terminal and submitted with Enter, the refusal is a click on the card's own deny control, and the
// absence of `NotebookRunDeclinedError` / `Error invoking remote method` is asserted, not assumed.
//
// WHY A READY RUNTIME IS SEEDED HERE, AND WHY THAT IS STILL A REAL READING: the control this sentence
// comes from — the pane's own terminal — is gated on the app's own `pythonReady` (`notebookGated`). The
// gate itself is a readiness marker plus the presence of the interpreter, so this spec writes exactly
// those two things into its own isolated data root; nothing is executed either way, because the run is
// refused at the card before a kernel is ever started (stated separately by the run-record assertion at
// the end). A stub is also the only shape available to this lane: a fresh isolated root has no runtime,
// and provisioning one means downloading a language pack.
//
// AND WHY THE LANE ITSELF CAN STILL BE UNABLE TO HOST THIS READING: with no provisioner on hand the app
// answers `notebookEnv.getStatus()` from a fallback that reports `pythonReady: false` whatever is on
// disk (`createUnavailableLifecycle` — an unprovisioned development build, or a packaged app whose
// micromamba resource is missing). No seeding can open the pane there, so that case is named and
// skipped rather than left to look like a product failure. The two shapes are distinguishable without
// guessing: only the provisioner-backed status carries the recovery-blocked fields.
const PROBE_CODE = "shutil.rmtree('probe-dir')"
// The version the runtime layout helper expects for a current marker (`DEFAULT_ENV_VERSION`).
const RUNTIME_MARKER_VERSION = 1

type NotebookEnvStatus = {
  pythonReady?: boolean
  pythonRecoveryBlocked?: boolean
  rRecoveryBlocked?: boolean
}

const seedReadyRuntime = (dataRoot: string): string => {
  const root = join(dataRoot, 'runtime')
  const bin = join(root, 'envs', 'default-python', 'bin')
  mkdirSync(bin, { recursive: true })
  // A placeholder interpreter: nothing here is ever spawned (the run is declined first), the gate only
  // asks whether the file is there.
  writeFileSync(join(bin, 'python'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'python'), 0o755)
  writeFileSync(
    join(root, '.env-ready'),
    `${JSON.stringify(
      { defaultEnvVersion: RUNTIME_MARKER_VERSION, preparedAt: new Date().toISOString() },
      null,
      2
    )}\n`
  )
  return root
}

test.setTimeout(180_000)

test('a declined notebook run is re-said in words instead of the engine error it arrived as', async ({
  app
}) => {
  let page = await app.completeOnboarding()

  // The runtime root is derived from the app's own data root, so ask the app rather than guessing a path.
  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot?: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot ?? ''
  })
  expect(dataRoot).not.toBe('')
  const runtimeRoot = seedReadyRuntime(dataRoot)
  console.log(`[b1-declined] seeded a ready runtime at ${runtimeRoot}`)

  // configureFakeAgent relaunches the app, so the fresh process reads the runtime seeded above.
  page = await app.configureFakeAgent()
  const status = (await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { notebookEnv: { getStatus: () => Promise<NotebookEnvStatus> } }
    }
    return bridge.api.notebookEnv.getStatus()
  })) as NotebookEnvStatus
  console.log(`[b1-declined] the app reports: ${JSON.stringify(status)}`)

  const hasProvisioner = 'pythonRecoveryBlocked' in status || 'rRecoveryBlocked' in status
  test.skip(
    !hasProvisioner && status.pythonReady !== true,
    `skipped: this build answers notebook-env:getStatus from its fallback (no provisioner), which reports pythonReady:false whatever is on disk, so the pane's own run control is disabled here — the sentence this spec asserts is unreachable in this lane, not missing. Reported as: ${JSON.stringify(status)}`
  )

  // The premise, proven rather than assumed — otherwise the terminal below stays disabled and this spec
  // would report the sentence as missing when it had never been reachable.
  expect(status.pythonReady).toBe(true)

  await createProject(page, 'Notebook declined copy')
  await sendPrompt(page, 'Create a provenance artifact.', 'Artifact provenance verified', 120_000)

  await expect(page.getByTestId('kernel-notebook-pane')).toBeAttached({ timeout: 60_000 })
  await page.getByTestId('workspace-preview-toggle').click()
  const pane = page.getByTestId('kernel-notebook-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })

  // Type the flagged line the way a reader would, then submit it with Enter.
  const terminal = page.getByTestId('kernel-terminal-input')
  await expect(terminal).toBeEnabled({ timeout: 60_000 })
  await terminal.fill(PROBE_CODE)
  await terminal.press('Enter')

  // The card asks first, and names what it found — the same card the agent's own calls use.
  const review = page.getByTestId('notebook-risk-review')
  await expect(review).toBeVisible({ timeout: 60_000 })
  await expect(review).toContainText('deletes files')
  await expect(review).toContainText('fs-delete')

  // Decline through the card's own control.
  await page.getByTestId('deny-button').click()
  await expect(review).toHaveCount(0, { timeout: 30_000 })

  // What the reader is left with: the refusal in the card's words, with the machine id inline, and with
  // neither the engine's class name nor the transport's envelope.
  const strip = page.getByTestId('kernel-terminal')
  await expect(strip).toContainText('Notebook run declined', { timeout: 30_000 })
  await expect(strip).toContainText('deletes files (fs-delete)')
  await expect(strip).toContainText('no code was executed')
  await expect(strip).not.toContainText('NotebookRunDeclinedError')
  await expect(strip).not.toContainText('Error invoking remote method')
  console.log(`[b1-declined] the strip says: ${JSON.stringify(await strip.innerText())}`)

  // And the declined cell never ran. Scoped to this cell's script on purpose: the provenance fixture
  // this spec drives through leaves the session with a run of its own, so "no runs at all" would be an
  // assertion about the fixture rather than about the refusal.
  const runs = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        notebook: {
          state: (request: Record<string, unknown>) => Promise<{
            runs?: Array<{ script?: string }>
          }>
          getReference: (
            request: Record<string, unknown>
          ) => Promise<{ projectName?: string } | null>
        }
        sessions: { loadAll: () => Promise<unknown> }
      }
    }
    const loaded = (await bridge.api.sessions.loadAll()) as
      { sessions?: Array<{ id?: string; cwd?: string }> } | Array<{ id?: string; cwd?: string }>
    const list = Array.isArray(loaded) ? loaded : (loaded.sessions ?? [])
    const found = list.find((entry) => typeof entry.cwd === 'string' && entry.cwd !== '')
    if (!found?.id || !found.cwd) return null
    const reference = await bridge.api.notebook.getReference({
      sessionId: found.id,
      workspaceCwd: found.cwd
    })
    const projectName = reference?.projectName ?? ''
    if (!projectName) return null
    const state = await bridge.api.notebook.state({
      sessionId: found.id,
      workspaceCwd: found.cwd,
      projectName
    })
    return (state.runs ?? []).map((run) => run.script ?? '')
  })
  expect(runs).not.toBeNull()
  expect((runs ?? []).filter((script) => script.includes('rmtree'))).toEqual([])
})
