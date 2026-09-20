import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// Throwaway probe: a trusted click reaches the button but React's onClick never runs. Find out who
// interferes between the button and the React root.
test('probe who swallows the click', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Click probe project')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Summarise the calibration notes')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled()

  await page.evaluate(() => {
    const state = { stops: [] as string[], bubble: [] as string[] }
    ;(window as unknown as { __click: typeof state }).__click = state
    const original = Event.prototype.stopPropagation
    Event.prototype.stopPropagation = function patched(this: Event) {
      state.stops.push(`${this.type}@${(this.target as HTMLElement | null)?.getAttribute('data-slot') ?? (this.target as HTMLElement | null)?.tagName ?? '?'} :: ${new Error().stack?.split('\n')[2]?.trim() ?? 'no stack'}`)
      return original.call(this)
    }
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null
      state.bubble.push(`bubble:${target?.getAttribute('data-slot') ?? target?.tagName ?? '?'} prevented=${event.defaultPrevented}`)
    })
  })

  await page.getByTestId('conversation-title-button').click()
  const measure = page.locator('[data-slot="session-fork-measure"]')
  const pin = page.getByRole('button', { name: 'Pin' })

  // Same instrumentation, two buttons: the one that does nothing and the one that works.
  // Tag the current card node: if the card is remounted mid-interaction, the tag will be gone.
  await page.evaluate(() => {
    document.querySelector('[data-slot="session-info-card"]')?.setAttribute('data-probe-tag', 'original')
  })
  console.log('[probe] tag before click:', await page.locator('[data-probe-tag="original"]').count())
  // Does an ordinary click in the header row (the pin) remount it too?
  await pin.click()
  await page.waitForTimeout(1000)
  console.log('[probe] tag after PIN click:', await page.locator('[data-probe-tag="original"]').count())
  await page.evaluate(() => {
    document.querySelector('[data-slot="session-info-card"]')?.setAttribute('data-probe-tag', 'original')
  })
  await measure.click()
  await page.waitForTimeout(1500)
  console.log('[probe] tag after fork click:', await page.locator('[data-probe-tag="original"]').count())
  console.log('[probe] cards after fork click:', await page.locator('[data-slot="session-info-card"]').count())
  console.log('[probe] manifest after fork click:', await page.locator('[data-slot="session-fork-manifest"]').count())
  await pin.click()
  await page.waitForTimeout(800)

  console.log('[probe] stops:', await page.evaluate(() => JSON.stringify((window as unknown as { __click: { stops: string[] } }).__click.stops)))
  console.log('[probe] bubble clicks:', await page.evaluate(() => JSON.stringify((window as unknown as { __click: { bubble: string[] } }).__click.bubble)))
  console.log('[probe] manifest after both clicks:', await page.locator('[data-slot="session-fork-manifest"]').count())
  console.log('[probe] pinned after both clicks:', await page.locator('[data-slot="session-info-card"]').getAttribute('data-pinned'))
})
