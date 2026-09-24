import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// U27: a local model service could be registered but never started, because the approval its start
// gate requires had no entry in the window (`endpoint:approve` had zero callers while
// `endpoint-manager` refused an unapproved hash). This drives the affordance in the packaged app:
// the pending state is visible, the exact bytes are shown before approving, and approving clears the
// state through the real IPC — with the start button gated until then.
test('a local service that needs approval says so, and approving clears it', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Endpoint approval evidence')

  // Register through the same channel the panel uses; registering is not what this entry fixes.
  await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        endpoint: {
          register: (request: {
            sessionId: string
            request: Record<string, string>
          }) => Promise<unknown>
        }
      }
    }
    await bridge.api.endpoint.register({
      sessionId: 'e2e-approval',
      request: {
        name: 'e2e-echo',
        url: 'http://127.0.0.1:28917',
        skillName: 'echo-api',
        startScript: 'echo e2e-start-28917',
        stopScript: 'echo e2e-stop-28917',
        livePath: '/health/ready'
      }
    })
  })

  // The sidebar entry to settings is labelled per view ('Settings' from the project view, 'Model
  // settings' once a conversation is open); take whichever the current view shows.
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Local models' })
    .click()

  const badge = settings.getByTestId('endpoint-approval-badge')
  await expect(badge).toBeVisible({ timeout: 30_000 })
  // The play button cannot work before approval, so it must not pretend it can.
  await expect(settings.getByRole('button', { name: 'Start' })).toBeDisabled()

  // What is being approved has to be readable before approving it.
  const scripts = settings.getByTestId('endpoint-approval-scripts')
  await scripts.locator('summary').click()
  await expect(scripts).toContainText('echo e2e-start-28917')
  await expect(scripts).toContainText('echo e2e-stop-28917')

  await settings.getByTestId('endpoint-approve').click()

  await expect(badge).toHaveCount(0)
  await expect(settings.getByTestId('endpoint-approve')).toHaveCount(0)
  await expect(settings.getByRole('button', { name: 'Start' })).toBeEnabled()
})
