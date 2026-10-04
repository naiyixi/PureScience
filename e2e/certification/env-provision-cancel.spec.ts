import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// IC16 on a real window: the environment-preparation gate has to be escapable.
//
// The unit layer already covers the wiring (Cancel calls the store's `cancel('python')`; an additive
// upgrade deliberately draws no Cancel — NotebookPreview.gate.render.test.tsx). The first attempt at a
// real reading came back with a finding instead of a reading: with python merely ABSENT, `notebookGated`
// is true but the overlay renders nothing, because the gate's state is `ready` while no run is in flight
// — the pane only carries the line "The environment is still being prepared", and there is no Retry to
// press. So the reading must start a provision for real, through the Runtimes panel's own button, and
// that provision is made DETERMINISTICALLY slow: the runtime download base points at a socket that
// accepts and never answers.
const STALL_PORT = 41997
process.env.PURESCIENCE_ENV_CDN_BASE = `http://127.0.0.1:${STALL_PORT}`
// The isolated instance ships no micromamba of its own and would refuse before downloading anything; the
// lock-import spec points it at the real binary the same way.
process.env.PURESCIENCE_MICROMAMBA_BIN = join(
  homedir(),
  '.purescience',
  'runtime',
  'micromamba',
  'bin',
  'micromamba'
)

const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
// The drip must be FAST ENOUGH TO EMIT PROGRESS: at one byte per tick the app publishes no progress
// events at all, the store's status never reports `provisioning: true`, and the gate therefore renders
// nothing (measured — 60 s of `gate: 0` after a retry). 8 KB every 200 ms over a declared 16 MB gives a
// progress event every few seconds while still not finishing inside the reading's window.
const PACK_BYTES = 16_777_216
const DRIP_INTERVAL_MS = 200
const DRIP_CHUNK = 'x'.repeat(8 * 1024)

let cdn: Server
let manifestAttempts = 0

// A stand-in CDN that lets the reading reach the one state IC16 is about — a WORKSPACE provision that is
// in flight and therefore cancellable, with the Cancel rendered in the notebook gate:
//   · the FIRST manifest request fails (HTTP 500). The manifest is fetched under an ABSOLUTE timeout, so
//     a silent socket only produces a timeout; a named failure is what drives the gate into its error
//     state, which is where the workspace's own Retry lives (a panel-initiated provision does not gate
//     the pane at all — measured: 24 snapshots over two minutes with `provisioning: true`, `gate: 0`);
//   · every later request serves a valid manifest instantly (the schema the parser requires) and drips the
//     pack archive a byte at a time, which never finishes because the pack fetch aborts only on STALL.
test.beforeAll(async () => {
  cdn = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    if (path.endsWith('/manifest.json')) {
      manifestAttempts += 1
      console.log(`[ic16-cdn] manifest request #${manifestAttempts}`)
      if (manifestAttempts === 1) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'cdn-down' }))
        return
      }
      const entry = (version: string): Record<string, unknown> => ({
        language: 'python',
        version,
        file: `python-${version}.tar.zst`,
        sha256: '0'.repeat(64),
        size: PACK_BYTES
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          schema: 1,
          envVersion: 1,
          subdir: PACK_SUBDIR,
          packs: { 'python-3.12': entry('3.12'), 'python-3.13': entry('3.13') }
        })
      )
      return
    }
    console.log(`[ic16-cdn] pack drip start: ${path}`)
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(PACK_BYTES)
    })
    const drip = setInterval(() => response.write(DRIP_CHUNK), DRIP_INTERVAL_MS)
    response.on('close', () => clearInterval(drip))
  })
  await new Promise<void>((resolve) => cdn.listen(STALL_PORT, '127.0.0.1', () => resolve()))
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => cdn.close(() => resolve()))
})

test.setTimeout(420_000)

test('cancels a first-time environment provision from the notebook gate, and leaves nothing half-installed', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Env provision cancel')
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    120_000
  )

  // The agent's first notebook call promotes the pane on its own; the panel it lands in can be collapsed.
  await expect(page.getByTestId('kernel-notebook-pane')).toBeAttached({ timeout: 60_000 })
  await page.getByTestId('workspace-preview-toggle').click()
  const pane = page.getByTestId('kernel-notebook-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })

  // Start the provision through the panel's own affordance for python — the road a user takes. (Without
  // a run in flight the overlay renders nothing at all, so there is nothing to cancel until this runs.)
  // The entry is the workspace rail's "Settings": "Model settings" is the home screen's button and is not
  // present once the workspace is showing (the first attempt at this reading used it and timed out).
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Runtimes' })
    .click()
  await settings
    .getByTestId('runtimes-cards-python')
    .getByRole('button', { name: 'Download and set up' })
    .click()
  // Escape does not close this modal (learned the hard way); the explicit control does.
  await settings.getByRole('button', { name: 'Close settings' }).click()

  // The panel-initiated provision fails at the first manifest request, which drives the gate into its
  // error state — the state that carries the workspace's OWN retry. (Measured: a panel-initiated
  // provision that gets past the manifest does not gate the pane at all — 24 snapshots over two minutes
  // with `provisioning: true` and no gate element in the DOM.)
  const gate = pane.getByTestId('notebook-env-gate')
  await expect(gate).toBeVisible({ timeout: 120_000 })
  await expect(pane.getByTestId('notebook-env-retry')).toBeVisible({ timeout: 60_000 })
  console.log(`[ic16] gate in its error state: ${(await gate.innerText()).replace(/\s+/g, ' ')}`)

  // The retry is the workspace's own provision. Against this CDN it stays in flight (manifest served,
  // pack dripping), so the gate offers exactly the Cancel IC16 is about.
  await pane.getByTestId('notebook-env-retry').click()

  // Refresh the state the way a user does (open and close the Runtimes panel). This step is not a trick
  // to make the test pass: it is the finding this reading produced. The store re-reads the authoritative
  // status on init, but the main process's progress broadcasts do NOT reach the renderer store in this
  // build — measured: the pack was downloading (main: `provisioning: true`, 2% at 39.8 KB/s, ~6m43s ETA)
  // for a full minute while the gate rendered nothing at all. Only a status re-read drives the ui into
  // 'preparing', and with it renders the Cancel. Filed as its own gap; the reading below proves the
  // Cancel itself works once the gate is up.
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const refreshSettings = page.getByRole('dialog', { name: 'Settings' })
  await refreshSettings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Runtimes' })
    .click()
  await refreshSettings.getByRole('button', { name: 'Close settings' }).click()

  await expect(gate).toBeVisible({ timeout: 60_000 })
  const cancel = pane.getByTestId('notebook-env-cancel')
  await expect(cancel).toBeVisible({ timeout: 60_000 })
  console.log(`[ic16] gate while preparing: ${(await gate.innerText()).replace(/\s+/g, ' ')}`)

  await cancel.click()

  // The abort has to be real: the gate leaves 'preparing' (its Cancel has nothing left to abort), python
  // is still NOT ready, and no run is left in flight — an aborted first install must not read as done.
  await expect(pane.getByTestId('notebook-env-cancel')).toHaveCount(0, { timeout: 90_000 })
  const status = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        notebookEnv: {
          getStatus: () => Promise<{ pythonReady: boolean; rReady: boolean; provisioning: boolean }>
        }
      }
    }
    return bridge.api.notebookEnv.getStatus()
  })
  console.log(`[ic16] status after cancel: ${JSON.stringify(status)}`)
  expect(status.pythonReady).toBe(false)
  expect(status.provisioning).toBe(false)
  // Still honest about where it stands: python is not ready, so the pane keeps saying so rather than
  // presenting an environment that was never installed. (Two elements legitimately carry such text — the
  // gate's title and the pane's own inline notice — so this asserts presence, not uniqueness.)
  await expect(
    pane.getByText(/still being prepared|needs attention|Environment setup/i).first()
  ).toBeVisible({ timeout: 60_000 })
})
