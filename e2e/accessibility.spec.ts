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
