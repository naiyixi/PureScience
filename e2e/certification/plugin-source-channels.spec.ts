import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// E3-1 (v2.3.0): the plugin creator's two channels, driven on a real window through the app's own bridge.
//
// Deterministic by design: an unqualified reference is refused BY NAME before any request, so this spec
// never touches a third party and can live in the lane. What it proves is that the four layers are actually
// connected — catalog, main handler, preload and the renderer contract — because the call only returns the
// module's own refusal if every one of them passed it through.
test('the plugin source channels answer through the window, and refuse without a request', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Plugin source channels')

  const reading = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        specialist: {
          pluginSourcePreview: (request: { reference: string }) => Promise<unknown>
          pluginSourceCancel: () => Promise<unknown>
        }
      }
    }
    const refused = await bridge.api.specialist.pluginSourcePreview({ reference: 'acme/plugin' })
    // A blank reference is refused by the transport guard rather than by the module: nothing to check means
    // nothing to send, and the sentence the guard throws carries the channel name.
    const blank = await bridge.api.specialist
      .pluginSourcePreview({ reference: '   ' })
      .then(() => 'accepted')
      .catch((error: unknown) => String(error))
    const cancelled = await bridge.api.specialist.pluginSourceCancel()
    return { refused, blank, cancelled }
  })

  console.log(`[plugin-source] ${JSON.stringify(reading).slice(0, 400)}`)

  // The shape is the module's: a refusal names its reason, and the unqualified reference is the one the
  // rule exists for (an unqualified name would make the app guess a host, and guessing a host is guessing a
  // source of code).
  expect(reading.refused).toMatchObject({ state: 'unavailable', reason: 'invalid-reference' })
  expect(reading.blank).toContain('Invalid plugin source preview request')
  expect(reading.blank).toContain('specialist:plugin-source-preview')
  // The second channel answers too, and carries the count rather than swallowing it.
  expect(reading.cancelled).toMatchObject({ dropped: 0 })
})
