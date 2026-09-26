import { expect } from '@playwright/test'
import type { AxeResults } from 'axe-core'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const AXE_PATH = resolve(process.cwd(), 'node_modules/axe-core/axe.min.js')
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

type BlockingViolation = {
  id: string
  impact: string | null
  help: string
  nodes: Array<{ html: string; target: unknown }>
}

const expectNoBlockingViolations = async (page: Page, surface: string): Promise<void> => {
  const axeSource = await readFile(AXE_PATH, 'utf8')
  await page.evaluate(axeSource)
  const results = (await page.evaluate(async (tags) => {
    const axe = (
      globalThis as unknown as {
        axe: { run: (context: Document, options: unknown) => Promise<unknown> }
      }
    ).axe

    return axe.run(document, { runOnly: { type: 'tag', values: tags } })
  }, WCAG_TAGS)) as AxeResults
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map<BlockingViolation>(({ id, impact, help, nodes }) => ({
      id,
      impact: impact ?? null,
      help,
      nodes: nodes.map(({ html, target }) => ({ html, target }))
    }))

  expect(blocking, `${surface} has blocking axe violations`).toEqual([])
}

const waitForFiniteAnimations = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const animations = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    await Promise.allSettled(animations.map((animation) => animation.finished))
  })
}

test('has no blocking accessibility violations in startup and home surfaces', async ({ app }) => {
  await expect(app.page.locator('#onboarding-introduction-title')).toBeVisible()
  await expectNoBlockingViolations(app.page, 'Onboarding')

  const page = await app.completeOnboarding()
  await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
  await expectNoBlockingViolations(page, 'Home')
})

test('has no blocking accessibility violations in core dialog and workspace surfaces', async ({
  app
}) => {
  const page = await app.completeOnboarding()

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await expect(projectDialog).toBeVisible()
  await expectNoBlockingViolations(page, 'New project dialog')

  await projectDialog.getByLabel('Name').fill('Accessible Electron project')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
  await expectNoBlockingViolations(page, 'Workspace')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expectNoBlockingViolations(page, 'Settings')
})

test('has no blocking accessibility violations in permission and file preview states', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await projectDialog.getByLabel('Name').fill('Accessible dynamic states')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill('Request fixture permission.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Write fixture output', { exact: true })).toBeVisible()
  await waitForFiniteAnimations(page)
  try {
    await expectNoBlockingViolations(page, 'Permission request')
  } finally {
    await page.getByRole('button', { name: 'Deny', exact: true }).click()
  }
  await expect(page.getByText('Fixture permission denied.', { exact: true })).toBeVisible()

  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'accessible-preview.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Accessible preview\n\nRendered in the file dialog.')
  })
  await expect(
    page.getByRole('button', { name: 'Remove attachment accessible-preview.md' })
  ).toBeVisible()
  await composer.fill('Preview the attached file.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('button', { name: 'Preview uploaded file accessible-preview.md' }).click()
  const preview = page.getByRole('dialog', { name: 'Preview accessible-preview.md' })
  await expect(preview).toBeVisible()
  await waitForFiniteAnimations(page)
  await expectNoBlockingViolations(page, 'File preview dialog')
})

// The keyboard-closure contract: every surface a keyboard opens takes focus when it opens, closes on
// Escape, and hands focus back to where it came from instead of dropping it on the body.
test('keyboard-opened surfaces close on Escape and hand focus back', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  const opener = page.getByRole('button', { name: /Search sessions and artifacts/ })
  // Reach it the way a keyboard user does — a mouse click does not necessarily park focus there.
  await opener.focus()
  await page.keyboard.press('Enter')
  const palette = page.getByTestId('global-search-dialog')
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  // Focus goes back to the control that opened it rather than to the body.
  await expect(opener).toBeFocused()

  const bell = page.getByRole('button', { name: /^Messages/ })
  await bell.focus()
  await page.keyboard.press('Enter')
  await expect(bell).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(bell).toHaveAttribute('aria-expanded', 'false')
  await expect(bell).toBeFocused()

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await projectDialog.getByLabel('Name').fill('Keyboard closure project')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'keyboard-closure.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Keyboard closure\n\nShift+F10 target.')
  })
  await composer.fill('Preview the attached file.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('button', { name: 'Preview uploaded file keyboard-closure.md' }).click()
  const modalPreview = page.getByRole('dialog', { name: 'Preview keyboard-closure.md' })
  await expect(modalPreview).toBeVisible()
  await page.getByRole('button', { name: 'Close preview of keyboard-closure.md' }).click()
  await expect(modalPreview).toBeHidden()

  // The workbench panel is the surface whose file-actions menu was pointer-only.
  await page
    .getByRole('button', { name: /keyboard-closure\.md/ })
    .first()
    .click()
  const card = page.locator('[data-testid="preview-card"]')
  await expect(card).toBeVisible()
  await card.focus()
  // Shift+F10 is the right-click equivalent: this menu had no keyboard route at all.
  await page.keyboard.press('Shift+F10')
  const menu = page.locator('[role="menu"]')
  await expect(menu).toBeVisible()
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role') ?? 'missing')).toBe(
    'menuitem'
  )
})

// The other half of the dialog-focus sweep: `useDialogFocusRestore` is wired into every dialog that is
// opened from page state (no Radix Trigger) and the coverage guard keeps that list honest — this checks the
// behaviour a keyboard user actually feels, through the real entry points those dialogs have. Closing has to
// put focus back on the control that opened the dialog, not on <body>.
test('dialogs opened from page state hand focus back to their opener', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  // A project first: the rail (and its Settings button) belongs to the workspace surface.
  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await projectDialog.getByLabel('Name').fill('Focus return project')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()

  // The settings surface: a rail button opens it, Escape closes it. Without the restore this is the dialog
  // that stranded a keyboard user at the top of the document.
  const railSettings = page.getByRole('button', { name: 'Settings', exact: true })
  await railSettings.focus()
  await page.keyboard.press('Enter')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(railSettings).toBeFocused()

  // The workspace file preview: a file-row button opens it, its own close button closes it.
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'focus-return.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Focus return\n\nPreview me.')
  })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Preview the attached file.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const previewOpener = page.getByRole('button', { name: 'Preview uploaded file focus-return.md' })
  await previewOpener.click()
  const preview = page.getByRole('dialog', { name: 'Preview focus-return.md' })
  await expect(preview).toBeVisible()
  await page.getByRole('button', { name: 'Close preview of focus-return.md' }).click()
  await expect(preview).toBeHidden()
  await expect(previewOpener).toBeFocused()
})

// The AlertDialog side of the same sweep: `AlertDialog.Content` renders with role="alertdialog" and needed the
// same restore. Measured on the packaged app before wiring it: Escape and the dialog's own Cancel button both
// left `document.activeElement` on <body> while the button that opened it was still connected.
test('alert dialogs hand focus back to their opener as well', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await projectDialog.getByLabel('Name').fill('Alert dialog focus project')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Storage', exact: true }).click()

  const change = page.getByRole('button', { name: 'Change location' })
  await change.focus()
  await page.keyboard.press('Enter')
  const warn = page.getByRole('alertdialog')
  await expect(warn).toBeVisible()

  // The dialog focuses its own Cancel button on open, so Enter activates it: closing this way has to hand focus
  // back to the button that opened it. Escape is deliberately not the assertion path here — measured on the
  // packaged app it also dismisses the Settings dialog underneath, which unmounts the opener, so there is no
  // control left to return to (whether the inner layer should absorb Escape is tracked separately).
  await page.keyboard.press('Enter')
  await expect(warn).toBeHidden()
  await expect(change).toBeFocused()

  // Escape with this confirm open used to dismiss the Settings surface underneath as well: Radix listens for the
  // key on the document, so both layers reacted to one press. The nested layer has to absorb it and the opener
  // takes focus back — this packaged-app test is the lock for that (jsdom does not reproduce the double dismissal).
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await change.focus()
  await page.keyboard.press('Enter')
  await expect(warn).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(warn).toBeHidden()
  await expect(settings).toBeVisible()
  await expect(change).toBeFocused()
})
