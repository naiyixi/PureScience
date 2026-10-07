import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// IC42: the engine panel. Every fact on it comes from the same single sources the agent-facing projection uses,
// so this reading checks the two things that could silently drift apart:
//   ① each engine states, IN WORDS, why it can or cannot serve a request here — and the sentence is one of the
//      fixed set (a raw `engines.…` key or an empty cell would mean the copy never resolved);
//   ② the panel offers NO download control while no engine weight has a published checksum. The gate exists and
//      refuses every target in that state, and a button that must refuse every target is worse than no button —
//      so the honest shape is "the state is stated in words and there is nothing to press".
test.setTimeout(240_000)

const STATUS_TEXTS = [
  'Available',
  'Needs your approval to download',
  'Needs a compute host',
  'Unavailable here: no GPU proven',
  'Unavailable: no downloadable weights in this build'
]

test('the engine panel states why each engine is available or not, and offers no control it cannot honour', async ({
  app
}) => {
  // `configureFakeAgent` restarts the app and hands back the NEW page: the old one belongs to the previous
  // instance and is already closed. Holding a `const` here fails later with "Target page … has been closed"
  // while the aria snapshot still shows the startup splash — measured, on this very spec.
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Engine panel')

  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Compute' })
    .click()

  const matrix = page.locator('[data-slot="engine-matrix"]')
  await expect(matrix).toBeVisible({ timeout: 30_000 })
  const rows = page.locator('[data-slot="engine-matrix-row"]')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })

  const observed = await rows.evaluateAll((nodes) =>
    nodes.map((node) => ({
      status: node.getAttribute('data-engine-status') ?? '',
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    }))
  )
  console.log(
    `[ic42] engine rows=${observed.length}; statuses=${JSON.stringify(observed.map((row) => row.status))}`
  )
  expect(observed.length, 'the engine matrix rendered no engines at all').toBeGreaterThan(0)

  for (const row of observed) {
    const saysWhy = STATUS_TEXTS.some((sentence) => row.text.includes(sentence))
    expect(
      saysWhy,
      `an engine row does not state a known reason in words (status=${row.status}): "${row.text}"`
    ).toBe(true)
  }

  const blocked = observed.filter((row) => row.status === 'weights-unavailable')
  console.log(`[ic42] engines blocked by the weight gate: ${blocked.length} of ${observed.length}`)
  const controls = await matrix.getByRole('button').count()
  console.log(`[ic42] controls offered inside the engine matrix: ${controls}`)
  expect(
    controls,
    'the panel offered a control while no weight has a published checksum, so it can only refuse'
  ).toBe(0)
})
