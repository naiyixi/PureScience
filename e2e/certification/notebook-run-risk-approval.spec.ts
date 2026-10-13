import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// B1 (v2.1.0): a notebook cell the risk review flags must ASK before it runs, on the same approval card
// the agent's tool calls use, and declining must mean the cell never ran.
//
// How this is driven, and why in that shape: the RUN goes through the app's own preload bridge — the same
// call the notebook pane's run control makes, with `source: 'user'`, which is the origin the review keys
// on. Everything that DECIDES the outcome is the real window: the card is rendered by the real UI and the
// decline is a click on the card's own deny control. The premise the spec asserts instead of assuming is
// that the review ran BEFORE the runtime was provisioned: declining must leave no run record at all, so
// the cell cannot have reached a kernel.
const PROBE_CODE = "import shutil\nshutil.rmtree('probe-dir')"

test('a flagged notebook cell asks on the approval card, and declining means it never ran', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  // configureFakeAgent relaunches the app, so it hands back the NEW page: keeping the old handle here is
  // what made the first version of this spec die with "page, context or browser has been closed".
  page = await app.configureFakeAgent()
  await createProject(page, 'Notebook run risk')
  await sendPrompt(page, 'Create a provenance artifact.', 'Artifact provenance verified', 90_000)

  // A real session, taken from the app's own list — the review keys on the request's origin, and the
  // notebook services resolve a session by its id plus its own cwd.
  const session = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { sessions: { loadAll: () => Promise<unknown> } }
    }
    const loaded = (await bridge.api.sessions.loadAll()) as
      { sessions?: Array<{ id?: string; cwd?: string }> } | Array<{ id?: string; cwd?: string }>
    const list = Array.isArray(loaded) ? loaded : (loaded.sessions ?? [])
    const found = list.find((entry) => typeof entry.cwd === 'string' && entry.cwd !== '')
    return { id: found?.id ?? '', cwd: found?.cwd ?? '' }
  })
  expect(session.id).not.toBe('')

  // The project name every notebook call must carry: resolved through the app's own reference path (the
  // one the pane uses) instead of this spec inventing one.
  const projectName = await page.evaluate(
    async ({ sessionId, workspaceCwd }) => {
      const bridge = globalThis as unknown as {
        api: {
          notebook: {
            getReference: (
              request: Record<string, unknown>
            ) => Promise<{ projectName?: string } | null>
          }
        }
      }
      const reference = await bridge.api.notebook.getReference({ sessionId, workspaceCwd })
      return reference?.projectName ?? ''
    },
    { sessionId: session.id, workspaceCwd: session.cwd }
  )
  expect(projectName).not.toBe('')

  // Fire the flagged cell. Deliberately not awaited: the point of this spec is what happens while the
  // approval is pending, and the call only settles (by being refused) after the decision.
  await page.evaluate(
    ({ sessionId, workspaceCwd, projectName, code }) => {
      const bridge = globalThis as unknown as {
        api: { notebook: { execute: (request: Record<string, unknown>) => Promise<unknown> } }
      }
      void bridge.api.notebook
        .execute({ sessionId, workspaceCwd, projectName, code, language: 'python', source: 'user' })
        .catch((error: unknown) => {
          console.log(`[b1-risk] execute was refused with: ${String(error)}`)
          return undefined
        })
    },
    { sessionId: session.id, workspaceCwd: session.cwd, projectName, code: PROBE_CODE }
  )

  // The card has to name WHAT fired and WHERE — a sentence like "something is risky" is not reviewable.
  const review = page.getByTestId('notebook-risk-review')
  await expect(review).toBeVisible({ timeout: 60_000 })
  await expect(review).toContainText('deletes files')
  await expect(review).toContainText('fs-delete')
  // Line 2, not 1: the cell starts with an import, and the review points at the line that acts.
  await expect(review).toContainText('line 2')
  await expect(review).toContainText('shutil.rmtree')

  // Decline through the card's own control, as a user would.
  await page.getByTestId('deny-button').click()
  await expect(review).toHaveCount(0, { timeout: 30_000 })

  // Nothing ran: a declined cell leaves NO run record (a half-trusted record of a refused run would be
  // worse than none), which also proves the review preceded provisioning — no kernel was ever started.
  const runs = await page.evaluate(
    async ({ sessionId, workspaceCwd }) => {
      const bridge = globalThis as unknown as {
        api: {
          notebook: {
            state: (
              request: Record<string, unknown>
            ) => Promise<{ runs?: Array<{ script?: string }> }>
          }
        }
      }
      const state = await bridge.api.notebook.state({ sessionId, workspaceCwd })
      return (state.runs ?? []).map((run) => run.script ?? '')
    },
    { sessionId: session.id, workspaceCwd: session.cwd }
  )
  expect(runs.filter((script) => script.includes('rmtree'))).toEqual([])
})
