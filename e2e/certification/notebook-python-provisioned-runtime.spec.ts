import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

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
test('runs a python cell on a runtime the app provisions itself', async ({ app }) => {
  test.setTimeout(600_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Notebook without a pack')
  await sendPrompt(page, 'Run a python cell.', 'Python cell ran.', 300_000)
  await expect(page.getByText('Python cell ran.', { exact: false })).toBeVisible()
})
