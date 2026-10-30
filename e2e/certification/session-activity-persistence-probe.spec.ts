import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// Where do a finished turn's activities go? Two turns with tool activity, then the session document is read
// straight off disk: does IT carry both turns' activities, or only the last?
//
//   · both  ⇒ persistence is fine; the renderer's in-memory graph (and so the transcript) is what lags, and
//             the fix is to hydrate finished runs into the graph the moment a run ends.
//   · one   ⇒ the write path drops finished runs' activities, and the fix is in session persistence.
// The two have nothing in common, so this is measured instead of guessed.
process.env.PURESCIENCE_E2E_TOOL_EVENTS = '2'

test.setTimeout(300_000)

test.afterAll(() => {
  delete process.env.PURESCIENCE_E2E_TOOL_EVENTS
})

const FIXTURE_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'

const sendTurn = async (page: Page, prompt: string, turn: number): Promise<void> => {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(FIXTURE_REPLY, { exact: true })).toHaveCount(turn, {
    timeout: 120_000
  })
}

const sessionFiles = async (root: string): Promise<string[]> => {
  const sessionsRoot = join(root, 'sessions')
  const found: string[] = []
  for (const project of await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue
    for (const file of await readdir(join(sessionsRoot, project.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.json') && !file.name.includes('.summary.')) {
        found.push(join(sessionsRoot, project.name, file.name))
      }
    }
  }
  return found
}

test('reads the session document and says how many turns of activity it kept', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Activity persistence probe')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  await sendTurn(page, 'First turn.', 1)
  await sendTurn(page, 'Second turn.', 2)
  // The app writes the session document on turn completion; give that a beat before reading it.
  await page.waitForTimeout(3_000)

  const liveGroups = await page.locator('[data-testid="tool-group"]').count()
  const readings = []
  for (const file of await sessionFiles(app.storageRoot)) {
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      session?: { conversationGraph?: { activities?: unknown[]; activityGroups?: unknown[] } }
    }
    const graph = raw.session?.conversationGraph
    readings.push({
      file: file.slice(app.storageRoot.length + 1),
      graphActivities: graph?.activities?.length ?? 0,
      graphGroups: graph?.activityGroups?.length ?? 0
    })
  }

  console.log(`[persist] live tool-groups=${String(liveGroups)} ${JSON.stringify(readings)}`)
  expect(readings.length).toBeGreaterThan(0)
})
