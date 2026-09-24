import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// U29: the window's handoff seam (`handoff-lifecycle:*`) had a parallel implementation nothing installed,
// so the packaged app answered `No handler registered` — which is how U22 reddened 16 certification specs
// after it migrated the window onto this seam. The seam is now served from the production lifecycle, and
// this is the assertion that would have caught it: the channels answer, in the packaged app.
test("answers the window's handoff seam from the production lifecycle", async ({ app }) => {
  let page = await app.completeOnboarding()
  // configureFakeAgent hands back the page it navigates; evaluating on the previous handle is what the
  // first run of this spec got wrong ("Target page, context or browser has been closed").
  page = await app.configureFakeAgent()
  await createProject(page, 'Handoff seam evidence')

  const seam = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        handoff: {
          list: (request: { sessionId: string }) => Promise<unknown>
          retry: (request: { sessionId: string; originatingTurnId: string }) => Promise<unknown>
        }
      }
    }
    const events = await bridge.api.handoff.list({ sessionId: 'e2e-handoff-seam' })
    // A turn with no handoff record is a no-op, and saying so beats throwing a missing-handler error.
    const retried = await bridge.api.handoff.retry({
      sessionId: 'e2e-handoff-seam',
      originatingTurnId: 'e2e-turn-without-handoff'
    })
    return { events, retried }
  })

  expect(Array.isArray(seam.events)).toBe(true)
  expect(seam.retried).toBeUndefined()
})
