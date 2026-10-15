import { expect } from '@playwright/test'
import { join } from 'node:path'

import { GoalRepository } from '../src/main/goals/goal-repository'
import { test } from './fixtures/electron-app'

const SESSION_ID = 'e2e-session-goals'
// The fingerprint is the resolver's value, never the caller's: the repository stamps what the resolver
// returned, so a seeded record can only have been produced by the real configure/advance path.
const FINGERPRINT = 'b720f53ae927292914b178bd4cf49dd7e'
// The app's data root is `<storage parent>/<dataFolderName()>`, and from source that folder is
// PureScience-DEV (storage-root.ts: dataRootForParent / dataFolderName). The fixture hands us the
// parent; seeding anywhere else is exactly the mistake this reading exists to catch.
const DATA_FOLDER = 'PureScience-DEV'

test('shows what a session is pursuing, and which criterion a reading actually proved', async ({ app }) => {
  const dataRoot = join(app.storageRoot, DATA_FOLDER)
  const repository = new GoalRepository({ root: dataRoot })
  const goal = await repository.configure(SESSION_ID, {
    objective: 'Compile a method out of a recorded run',
    acceptance: ['the recorded run compiles into a callable skill', 'the second thing is not done yet']
  })
  await repository.advance(
    SESSION_ID,
    {
      goalId: goal.id,
      criterion: 'the recorded run compiles into a callable skill',
      reading: { kind: 'run', id: 'notebook-run-e2e-1', fingerprint: FINGERPRINT }
    },
    { resolve: async () => ({ ok: true, fingerprint: FINGERPRINT }) }
  )
  // Through the product's own reader, so a failure here means the seed, not the panel.
  expect((await repository.listAll()).goals).toHaveLength(1)

  const page = await app.completeOnboarding()
  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Goals and readings', exact: true })
    .click()

  await expect(settings.getByText('Compile a method out of a recorded run')).toBeVisible()
  // The criterion a reading met carries that reading: its run id and the app-computed fingerprint.
  await expect(settings.getByText(/notebook-run-e2e-1/)).toBeVisible()
  await expect(settings.getByText(/b720f53ae927/)).toBeVisible()
  // The criterion with no reading says so — "no evidence" must never render as "satisfied".
  await expect(settings.getByText(/Unmet — no reading yet/)).toBeVisible()
  // The control a reader actually presses.
  await settings.getByRole('button', { name: 'Refresh goals' }).click()
  await expect(settings.getByText('Compile a method out of a recorded run')).toBeVisible()
})
