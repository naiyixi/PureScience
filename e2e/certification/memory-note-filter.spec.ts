import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC44: the memory panel's copy already promises a searchable memory. This drives the real panel — create a
// category, add two notes through the panel's own composer, then filter. The list must narrow, and a filter
// that matches nothing must say so rather than looking like a category that holds no notes at all.
test.setTimeout(180_000)

test('filters memory notes, and tells a no-match filter apart from an empty category', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Memory', exact: true })
    .click()

  // A category of its own, so the notes below belong somewhere known. The label is the panel's own
  // ("New category") — looked up rather than guessed, after a round lost to guessing it.
  await settings.getByRole('button', { name: 'New category' }).click()
  const nameInput = settings.locator('[data-slot="memory-category-name-input"]')
  await expect(nameInput).toBeVisible()
  await nameInput.fill('Filter evidence')
  await settings.locator('[data-slot="memory-category-create"]').click()

  const composer = settings.locator('[data-slot="memory-note-composer"]')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  for (const note of ['Uses npmmirror for installs', 'Prefers concise answers']) {
    await composer.fill(note)
    await composer.press('Enter')
  }
  const cards = settings.locator('[data-memory-note]')
  await expect(cards).toHaveCount(2, { timeout: 30_000 })
  console.log(`[ic44] notes on screen before filtering: ${await cards.count()}`)

  const filter = settings.locator('[data-slot="memory-note-filter"]')
  await expect(filter).toBeVisible()
  await filter.fill('npmmirror')
  await expect(cards).toHaveCount(1, { timeout: 30_000 })
  console.log(
    `[ic44] after filtering "npmmirror": ${await cards.count()} note(s) — "${(
      await cards.first().innerText()
    )
      .replace(/\s+/g, ' ')
      .trim()}"`
  )

  // A filter that matches nothing is its own answer: not the "this category has no notes" screen.
  await filter.fill('zzz-no-such-note-anywhere')
  await expect(cards).toHaveCount(0, { timeout: 30_000 })
  const noMatch = settings.locator('[data-slot="memory-note-filter-empty"]')
  await expect(noMatch).toBeVisible()
  console.log(`[ic44] a filter that matches nothing says: "${(await noMatch.innerText()).trim()}"`)

  await filter.fill('')
  await expect(cards).toHaveCount(2, { timeout: 30_000 })
  console.log('[ic44] clearing the filter brings both notes back')
})
