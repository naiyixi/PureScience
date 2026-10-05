import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// IC43: a memory note records when recall LAST handed it to a session. Until now that field was declared,
// persisted, and even filtered on — and nothing in the app ever wrote it, so the promise had no producer.
//
// This reading drives the whole way round: write a note in the panel, run a session that has that memory
// injected (the backend resolution is where recall happens), then read the note back.
test.setTimeout(240_000)

test('a session that was given a memory note leaves the recall recorded on it', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  // A category and one note, through the panel's own controls.
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Memory', exact: true })
    .click()

  // The master switch has to be ON: with memory off, recall must not happen at all — which is exactly what
  // the first attempt showed (nothing was stamped, and the app was right to do so).
  const master = settings.getByRole('switch', { name: /memory/i }).first()
  await expect(master).toBeVisible()
  if ((await master.getAttribute('aria-checked')) !== 'true') {
    await master.click()
    console.log('[ic43] turned the memory master switch on')
  }
  await settings.getByRole('button', { name: 'New category' }).click()
  await settings.locator('[data-slot="memory-category-name-input"]').fill('Recall evidence')
  await settings.locator('[data-slot="memory-category-create"]').click()

  const composer = settings.locator('[data-slot="memory-note-composer"]')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await composer.fill('Prefers concise answers')
  await composer.press('Enter')

  const before = await settings.locator('[data-testid="memory-note-last-surfaced"]').count()
  console.log(`[ic43] notes claiming a past recall before any session ran: ${before}`)
  await page.keyboard.press('Escape')

  // A session. The backend resolution is the moment recall happens, so this is what must write the stamp.
  await createProject(page, 'Recall evidence')
  await sendPrompt(page, 'Remember that I prefer concise answers.', 'Deterministic reply:')

  // Discriminator: read the app's own stored memory back through the bridge, so "recall never ran" and "the
  // panel did not re-read" cannot be confused for one another.
  const stored = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { settings: { getMemory: () => Promise<unknown> } }
    }
    return bridge.api.settings.getMemory()
  })
  console.log(`[ic43] what the app stores after the session: ${JSON.stringify(stored)}`)

  // …and back to the note itself.
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const again = page.getByRole('dialog', { name: 'Settings' })
  await again
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Memory', exact: true })
    .click()

  // Reopening lands on the panel's landing view: a category has to be selected before its notes are shown.
  await again
    .getByRole('button', { name: /Recall evidence/ })
    .first()
    .click()

  const chip = again.locator('[data-testid="memory-note-last-surfaced"]')
  const chipCount = await chip.count()
  const memoryPanelText = (await again.innerText()).replace(/\s+/g, ' ').trim()
  console.log(
    `[ic43] after selecting the category again, last-recalled lines: ${chipCount}; the note is on screen: ${memoryPanelText.includes('Prefers concise answers')}`
  )
  await expect(chip.first()).toBeVisible({ timeout: 30_000 })
  console.log(
    `[ic43] the note now reads: "${(await chip.first().innerText()).replace(/\s+/g, ' ').trim()}"`
  )

  // IC43, the other half: which note replaced this one. The chain has a reader (recall skips superseded
  // notes) and had no writer; this drives the panel's own control and reads the stored record back.
  await again.locator('[data-slot="memory-note-composer"]').fill('Prefers terse answers')
  await again.locator('[data-slot="memory-note-composer"]').press('Enter')
  await expect(again.locator('[data-memory-note]')).toHaveCount(2, { timeout: 30_000 })

  const supersede = again.locator('[data-slot="memory-note-supersede"]').first()
  await expect(supersede).toBeVisible()
  const sibling = await supersede.locator('option').nth(1).getAttribute('value')
  expect(sibling).toBeTruthy()
  await supersede.selectOption({ value: sibling as string })
  console.log(`[ic43] marked a note as superseded by ${sibling}`)

  const supersededBadge = again.locator('[data-testid="memory-note-superseded"]')
  await expect(supersededBadge.first()).toBeVisible({ timeout: 30_000 })
  console.log('[ic43] the card now carries the superseded marker')

  // …and the app's own stored memory is the proof, not just the marker: read it back through the bridge.
  const afterSupersede = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { settings: { getMemory: () => Promise<unknown> } }
    }
    return bridge.api.settings.getMemory()
  })
  console.log(`[ic43] stored after superseding: ${JSON.stringify(afterSupersede)}`)
  expect(JSON.stringify(afterSupersede)).toContain(`"supersededBy":"${sibling}"`)
})
