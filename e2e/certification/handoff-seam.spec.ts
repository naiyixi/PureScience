import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// U29: the window's handoff seam (`handoff-lifecycle:*`) had a parallel implementation nothing installed,
// so the packaged app answered `No handler registered` — which is how U22 reddened 16 certification specs
// after it migrated the window onto this seam. The seam is now served from the production lifecycle, and
// this is the assertion that would have caught it: the channels answer, in the packaged app.
//
// IC46 removed the preload wrapper that invited `handoff.list` / `handoff.retry` — channel names the main
// process never registered (`handoff-lifecycle:list` / `:retry` were the declared ones, and even those had
// no registrar). The live face is the production lifecycle the UI itself calls, so the assertion belongs
// there now: `specialist.getHandoffEvents` answers with the session's events, and `specialist.retryHandoff`
// refuses a session with no handoff record by name rather than with a missing-handler error.
test("answers the window's handoff seam from the production lifecycle", async ({ app }) => {
  let page = await app.completeOnboarding()
  // configureFakeAgent hands back the page it navigates; evaluating on the previous handle is what the
  // first run of this spec got wrong ("Target page, context or browser has been closed").
  page = await app.configureFakeAgent()
  await createProject(page, 'Handoff seam evidence')

  const seam = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        specialist: {
          getHandoffEvents: (sessionId: string) => Promise<unknown>
          retryHandoff: (request: { id: string; sessionId: string }) => Promise<unknown>
        }
      }
    }
    const events = await bridge.api.specialist.getHandoffEvents('e2e-handoff-seam')
    // Capture both outcomes: whichever the production lifecycle chooses, it must not be a missing handler.
    let retryOutcome: string
    try {
      const retried = await bridge.api.specialist.retryHandoff({
        id: 'e2e-turn-without-handoff',
        sessionId: 'e2e-handoff-seam'
      })
      retryOutcome = `resolved:${JSON.stringify(retried ?? null)}`
    } catch (error) {
      retryOutcome = `rejected:${String((error as Error)?.message ?? error)}`
    }
    return { events, retryOutcome }
  })

  expect(Array.isArray(seam.events)).toBe(true)
  // The made-up session has no handoff record, so the seam answers with an empty list.
  expect(seam.events).toEqual([])
  expect(seam.retryOutcome).not.toMatch(/No handler registered/i)
})
