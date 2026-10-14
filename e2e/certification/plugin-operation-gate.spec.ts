import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// E3-2 (v2.3.0): the two operations that can change the machine — deploy and run-once — driven on a real
// window through the app's own bridge.
//
// Deterministic and offline by design: a token this app never issued is refused by name, so nothing is
// fetched, nothing is written and nothing is spawned. What it proves is that the layers are connected —
// catalog, main handler, preload and the renderer contract — because the refusal only comes back if every
// one of them passed the call through. The zero-write and zero-spawn properties of the gate itself are
// pinned where they are observable: in src/main/specialist/plugin-source.test.ts.
test('the plugin operations answer through the window and refuse a token this app never issued', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Plugin operation gate')

  const reading = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        specialist: {
          pluginSourceDeploy: (request: { token: string; confirmed: boolean }) => Promise<unknown>
          pluginSourceRunOnce: (request: { token: string; confirmed: boolean }) => Promise<unknown>
        }
      }
    }
    // Confirmed on purpose: the token is checked before the gate, so a confirmation cannot turn an unknown
    // token into an action.
    const deploy = await bridge.api.specialist.pluginSourceDeploy({
      token: 'never-issued-by-this-app',
      confirmed: true
    })
    const run = await bridge.api.specialist.pluginSourceRunOnce({
      token: 'never-issued-by-this-app',
      confirmed: true
    })
    // A blank token is refused by the transport guard rather than by the module: nothing to check means
    // nothing to send, and the sentence it throws carries the channel name.
    const blank = await bridge.api.specialist
      .pluginSourceDeploy({ token: '   ', confirmed: true })
      .then(() => 'accepted')
      .catch((error: unknown) => String(error))
    return { deploy, run, blank }
  })

  console.log(`[plugin-operation] ${JSON.stringify(reading).slice(0, 400)}`)

  for (const outcome of [reading.deploy, reading.run]) {
    expect(outcome).toMatchObject({ state: 'refused', reason: 'unknown-token' })
  }
  // The blank reference never reaches the module: the throw names the channel it was refused on.
  expect(reading.blank).toContain('specialist:plugin-source-deploy')
})
