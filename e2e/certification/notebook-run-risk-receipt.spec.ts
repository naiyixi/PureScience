import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// B1-3's writing point, and B2's first observable window the queue registered: a run that PASSES the review
// records a receipt — verdict, rule-set version, code hash and the hit list — beside the run itself.
//
// The hash the spec asserts is not read from the receipt: it is recomputed in the page with WebCrypto from
// the cell source the run record carries, which is a different implementation path than the one that wrote
// it. A receipt whose hash cannot be recomputed this way would be the thing worth worrying about.
const SAFE_CODE = 'total = 1 + 1\nprint(total)'

test('a run that passes the review carries a receipt this spec recomputes', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Notebook run receipt')
  await sendPrompt(page, 'Create a provenance artifact.', 'Artifact provenance verified', 90_000)

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

  // The cell asks for nothing on the rule list, so the review lets it through and the run happens.
  const execution = await page.evaluate(
    async ({ sessionId, workspaceCwd, projectName, code }) => {
      const bridge = globalThis as unknown as {
        api: { notebook: { execute: (request: Record<string, unknown>) => Promise<unknown> } }
      }
      try {
        const result = await bridge.api.notebook.execute({
          sessionId,
          workspaceCwd,
          projectName,
          code,
          language: 'python',
          source: 'user'
        })
        return { ok: true, result: JSON.stringify(result).slice(0, 400) }
      } catch (error) {
        return { ok: false, result: String(error).slice(0, 400) }
      }
    },
    { sessionId: session.id, workspaceCwd: session.cwd, projectName, code: SAFE_CODE }
  )
  expect(execution, `the run was refused: ${execution.result}`).toMatchObject({ ok: true })

  const reading = await page.evaluate(
    async ({ sessionId, workspaceCwd, code }) => {
      const bridge = globalThis as unknown as {
        api: {
          notebook: {
            state: (request: Record<string, unknown>) => Promise<{
              runs?: Array<{
                script?: string
                status?: string
                riskReview?: Record<string, unknown>
              }>
            }>
          }
        }
      }
      const state = await bridge.api.notebook.state({ sessionId, workspaceCwd })
      const runs = state.runs ?? []
      const run = runs.find((candidate) => (candidate.script ?? '') === code) ?? null
      if (!run) return { found: false as const, n_runs: runs.length }
      const source = run.script ?? ''
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
      const recomputed = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      return {
        found: true as const,
        status: run.status ?? null,
        receipt: (run.riskReview ?? null) as Record<string, unknown> | null,
        source,
        recomputed
      }
    },
    { sessionId: session.id, workspaceCwd: session.cwd, code: SAFE_CODE }
  )

  expect(
    reading.found,
    `no run record for the cell (runs in state: ${String(reading.n_runs)})`
  ).toBe(true)
  if (!reading.found) return

  // The receipt exists, names the rule set and its verdict, and its hash equals the one recomputed here.
  expect(reading.receipt).not.toBeNull()
  expect(reading.receipt?.ruleSetVersion).toBe('notebook-run-risk:v1')
  expect(reading.receipt?.verdict).toBe('allow')
  expect(reading.receipt?.hits).toEqual([])
  expect(reading.source).toBe(SAFE_CODE)
  expect(reading.receipt?.codeHash).toBe(reading.recomputed)
})
