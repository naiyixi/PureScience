import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'
import { DEFAULT_RUNTIME_CDN_BASE, runtimeSubdir } from '../../src/main/notebook/runtime-paths'

// A python cell runs on a machine that has no curated pack.
//
// Why this spec exists: the kernel-controls and runtime-binding lanes both drive a real python kernel, but
// both seed the pack from `~/.purescience/runtime/packs` — a directory that exists on the machine that built
// it and nowhere else. On a runner those lanes skip, so the python path was unproven exactly where it
// matters. This lane takes the route a fresh install takes instead: the app provisions its own runtime.
//
// Measured on this machine (2026-11-20, isolated storage root): the run fetched
// `releases/download/runtime-v1/osx-arm64-python-3.12.tar.zst` (HTTP 200) and the cell printed `ic14-python-cell`
// in 40s total. That is the whole point — nothing was pre-seeded, so the lane cannot pass by finding a pack
// that happens to be lying around.
//
// The assertion is the fixture's, not ours: the fixture agent asks the packaged notebook MCP for
// `print("ic14-python-cell")` and throws when the marker is missing from the result, so a green reply means a
// kernel really started and really printed.

// This lane is the only one that needs the network, and on 2026-11-23 a Windows runner lost the runtime host
// outright: `https://github.com/naiyixi/PureScience/releases/download/runtime-v1/win-64-manifest.json` died
// with `net::ERR_CONNECTION_TIMED_OUT` (the update check to the same host timed out in the same run), so the
// app never provisioned a runtime and the fixture's message — "The Notebook did not run the python cell" —
// accused the notebook for a host that was not answering.
//
// So the host is asked first, with the same base URL and the same platform segment the app uses. A host that
// does not answer is a skip that names the error; a host that answers leaves the assertion untouched, so a
// provisioning failure with the bundle in reach is still red. The distinction matters: "we could not reach
// the bundle" and "the bundle is here and the kernel still did not run" are different facts, and only the
// second one is about this product.
test('runs a python cell on a runtime the app provisions itself', async ({ app }) => {
  // The subject of this lane IS first-run provisioning: the app installs python-3.12 for the platform before the
  // cell can print anything. The fixture budgets that at 15 minutes (`PROVISION_AWARE_TIMEOUT_MS`), and the
  // wait here used to cut it off at 5 — so a provisioning run that was merely slow ended with the page showing
  // neither the reply nor the fixture's named failure, and the report accused nothing in particular. The wait
  // now outlives the provisioning budget it is waiting for.
  test.setTimeout(1_020_000)

  const manifestUrl = `${DEFAULT_RUNTIME_CDN_BASE}/${runtimeSubdir()}-manifest.json`
  let reachable = false
  let reachError = ''
  try {
    const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(20_000) })
    reachable = response.ok
    if (!reachable) reachError = `HTTP ${response.status}`
  } catch (error) {
    reachError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  test.skip(
    !reachable,
    `runtime host unreachable from this runner (${reachError}) — the fresh-install path cannot be exercised: ${manifestUrl}`
  )

  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Notebook without a pack')
  await sendPrompt(page, 'Run a python cell.', 'Python cell ran.', 960_000)
  await expect(page.getByText('Python cell ran.', { exact: false })).toBeVisible()
})
