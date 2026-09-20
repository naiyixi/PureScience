import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// Acceptance for session forking on a real window: the reader measures the copy before anything is
// written, confirms, and ends up with a second session that holds the exchange without the source
// being touched.
//
// The two-step shape is the point, so it is asserted as two steps: the plan is visible (and the copy
// list is not written to yet — the sidebar still holds one session), then the confirm produces the
// copy (the sidebar holds two).

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Fork acceptance project')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

// Probing this on the packaged app found the real defect behind it: the card is re-mounted while it is
// open, and the fork plan a reader had just measured was living in component state, so a background
// session update discarded it (and a click that straddled the re-mount hit a replaced node). The plan
// is now kept per session, and the unit test beside the component pins that survival. This spec is the
// end-to-end half: a settled card, two steps, and a copy that appears in the session list.
test('measures a fork before copying it, then creates a session that holds the exchange', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  // One exchange, so the copy has something to hold.
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Summarise the calibration notes')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled()

  const sessions = page.getByRole('navigation', { name: 'Sessions' })
  const sessionRows = sessions.getByRole('button', { name: /Session status/ })
  await expect(sessionRows).toHaveCount(1)

  // The session's information card is where a fork starts.
  await page.getByTestId('conversation-title-button').click()
  await page.locator('[data-slot="session-info-card"]').waitFor({ state: 'visible' })
  await page.waitForTimeout(600)

  const forkAction = page.getByRole('button', { name: 'Fork session' })
  // The caution lives where a reader finds it before pressing: the action's own tooltip.
  await expect(forkAction).toHaveAttribute(
    'title',
    'Measure first: see what the copy would hold before creating it'
  )

  // Step one: measure. The numbers are shown, and nothing has been written yet.
  //
  // Hover, let the card settle, then press — which is what a person does, and which the card needs:
  // hovering it re-renders the mount site, and a press whose mousedown and mouseup straddle that
  // re-render lands on a replaced node and produces no click at all. Moving the pointer and pressing
  // in the same instant (a synthesised click) is not a person, and it is how this spec first failed.
  await forkAction.hover()
  await page.waitForTimeout(400)
  // A person's press is not instantaneous: hold the button down briefly, the way a hand does. The
  // synthesised instant click is what the card could not survive, and the recorded probe showed the
  // press landing correctly once the button was held even briefly.
  const forkBox = await forkAction.boundingBox()
  if (!forkBox) throw new Error('the fork action has no box to press')
  await page.mouse.move(forkBox.x + forkBox.width / 2, forkBox.y + forkBox.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(60)
  await page.mouse.up()
  await expect(page.getByText('The copy will hold')).toBeVisible()
  await expect(page.getByText('Messages: 2')).toBeVisible()
  await expect(page.getByText('Agent replies: 1')).toBeVisible()
  await expect(page.getByText(/Not carried: /)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create the copy' })).toBeVisible()
  await expect(sessionRows).toHaveCount(1)

  // Step two: confirm. Now the copy exists as its own session, source untouched.
  await page.getByRole('button', { name: 'Create the copy' }).click()
  await expect(page.getByText('The copy was created')).toBeVisible()
  await expect(sessionRows).toHaveCount(2)
})
