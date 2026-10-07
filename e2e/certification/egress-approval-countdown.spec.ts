import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// IC33: the egress approval card's remaining validity. The card is raised by the app's own egress proxy when a
// SUBPROCESS tries to reach a host nobody allowed — the app hands the proxy environment to every kernel/shell
// subprocess (`egressProxyEnv()`, kernel-executor.ts:700 and shell-process.ts:93). So this reading makes the
// fixture attempt a real outbound request and then reads the WINDOW: a live countdown while the request is
// pending, and — past the proxy's own deadline — a named explanation with nothing to press (by then the proxy
// has already refused, so a button could not end anything).
//
// The request uses python's `urllib`, not node's `http`: node's core client ignores `http_proxy`, so it would
// never reach the proxy and no card would ever be raised.
test.setTimeout(300_000)

test('the approval card counts down, and past its deadline it explains itself instead of offering a button', async ({
  app
}) => {
  // `configureFakeAgent` restarts the app and hands back the NEW page (the old one is closed).
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Egress approval card')

  // PRECONDITION, not the feature under test: the proxy only exists when egress is ON
  // (`egress-runtime.ts`: `currentEnabled = allowlist !== undefined`) and the setting DEFAULTS to
  // `{ enabled: false, groups: {}, customDomains: [] }` (`settings/service.ts:742`). With it off there is no
  // proxy environment for the subprocess at all, so the request never reaches the gate and no card can appear —
  // measured: that is exactly how this reading failed its first run. Set through the app's own settings channel
  // (allowed for a precondition), and read back, because "the call returned" is not "it took effect".
  const egressBefore = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { settings: { getEgress: () => Promise<unknown> } }
    }
    return bridge.api.settings.getEgress()
  })
  console.log(`[ic33] egress before: ${JSON.stringify(egressBefore)}`)
  await page.evaluate(
    async (current) => {
      const bridge = globalThis as unknown as {
        api: { settings: { setEgress: (settings: unknown) => Promise<unknown> } }
      }
      return bridge.api.settings.setEgress({ ...(current as Record<string, unknown>), enabled: true })
    },
    egressBefore as Record<string, unknown>
  )
  const egressAfter = (await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { settings: { getEgress: () => Promise<unknown> } }
    }
    return bridge.api.settings.getEgress()
  })) as { enabled?: unknown }
  console.log(`[ic33] egress after: ${JSON.stringify(egressAfter)}`)
  expect(egressAfter.enabled, 'egress could not be turned on, so no proxy exists and no card can appear').toBe(
    true
  )

  // Sent WITHOUT waiting for the reply: the turn is blocked inside the request while the proxy holds it for its
  // approval timeout, and that pending window is exactly when the card has to be on screen.
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Request a blocked outbound connection.')
  await page.getByRole('button', { name: 'Send message' }).click()

  const countdown = page.locator('[data-slot="egress-approval-countdown"]')
  await expect(countdown, 'the approval card never appeared for the blocked request').toBeVisible({
    timeout: 150_000
  })
  const first = (await countdown.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic33] the countdown reads: "${first}"`)

  // It has to MOVE: a number that never changes would be a rendering of a stored value, not a remaining validity.
  let moved = false
  for (let attempt = 0; attempt < 25 && !moved; attempt += 1) {
    await page.waitForTimeout(1000)
    const now = (await countdown.innerText()).replace(/\s+/g, ' ').trim()
    if (now !== first) {
      moved = true
      console.log(`[ic33] it moved to: "${now}"`)
    }
  }
  expect(moved, 'the countdown never moved within 25s, so it is not a live remaining validity').toBe(true)

  // Past the deadline: the fact stated in words, and nothing to press.
  const expired = page.locator('[data-slot="egress-approval-expired"]')
  await expect(expired, 'the card never reached its expired state').toBeVisible({ timeout: 150_000 })
  const text = (await expired.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic33] past the deadline it says: "${text}"`)
  console.log(
    `[ic33] countdown slots left: ${await page.locator('[data-slot="egress-approval-countdown"]').count()}; buttons in the expired card: ${await expired.getByRole('button').count()}`
  )
  expect(await page.locator('[data-slot="egress-approval-countdown"]').count()).toBe(0)
  expect(await expired.getByRole('button').count()).toBe(0)
})
