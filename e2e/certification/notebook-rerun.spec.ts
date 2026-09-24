import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for U21 on a real window: `notebook:run-cell` (and the cell-level write channels around it)
// had no renderer call site at all, so a recorded run row was a dead end — you could read a stale cell
// but nothing in the window could put it back on an interpreter. The row now carries the same command the
// agent uses, names the reason when it is unavailable, and reports what the run returned.
//
// The provenance fixture is the right driver here: it runs a real Bash cell through the notebook MCP and
// leaves the notebook running, so the session holds a live notebook reference and a recorded cell.

test.setTimeout(180_000)

test('re-runs a recorded notebook cell from the pane, and says why when it cannot', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Notebook rerun')
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    120_000
  )

  // The first agent-side notebook call promotes the notebook into the window on its own: the preview tab
  // appears without the reader asking for it. The pane can be mounted into a collapsed panel, so open the
  // panel before judging visibility.
  await expect(page.getByTestId('kernel-notebook-pane')).toBeAttached({ timeout: 60_000 })
  await page.getByTestId('workspace-preview-toggle').click()
  const pane = page.getByTestId('kernel-notebook-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })

  const cell = pane
    .getByTestId('notebook-cell')
    .filter({ has: page.getByTestId('notebook-cell-rerun') })
    .first()
  await expect(cell).toBeVisible()

  const rerun = cell.getByTestId('notebook-cell-rerun')
  if (await rerun.isDisabled()) {
    // A blocked row names the reason on the row itself: never a button that looks live and does nothing.
    await expect(cell.getByTestId('notebook-cell-rerun-blocked')).toHaveText(/\S/)
    return
  }

  await rerun.click()
  // The pane reports the outcome of the command it just sent: the interpreter's own status.
  await expect(page.getByText(/Re-ran this cell/)).toBeVisible({ timeout: 60_000 })
})
