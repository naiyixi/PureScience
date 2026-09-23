import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'

// Batch 1 acceptance: with an empty library, every first screen has to say why it is empty and what
// to do next. The fixture gives each run a fresh storage root, so "empty" here is the real thing —
// no seeded rows, no mocked stores.
//
// The palette has two empty states and they are not the same one: with no project at all it points at
// creating one, and once a project exists but holds nothing it names that emptiness instead of
// rendering a blank result area. The real build is the only place that distinction is observable, so
// both are asserted here.
const PROJECT_NAME = 'Empty library walkthrough'

const openSettingsPanel = async (page: Page, panel: string): Promise<Locator> => {
  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: panel })
    .click()

  return settings
}

const openPalette = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: /Search sessions and artifacts/ }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()

  return palette
}

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

test('an empty library explains itself on every first screen', async ({ app }) => {
  const page = await app.completeOnboarding()

  // Home: the project list arrives one IPC round-trip after the first paint. The empty state must
  // explain itself, and the loading row must not survive as a permanent first frame.
  await expect(page.getByText('No projects yet. Create one to get started.')).toBeVisible()
  await expect(page.getByTestId('home-projects-loading')).toHaveCount(0)
  await expect(page.getByText('Sessions you start will appear here.')).toBeVisible()

  // Search with no project yet: the palette says which action produces something to search.
  let palette = await openPalette(page)
  await expect(palette.getByText('Create a project to search sessions and artifacts.')).toBeVisible()
  await page.keyboard.press('Escape')

  // Permissions: a fresh profile has remembered no decisions.
  let settings = await openSettingsPanel(page, 'Permissions')
  await expect(settings.getByText('No permission decisions remembered yet')).toBeVisible()
  await settings.getByRole('button', { name: 'Close settings' }).click()

  // Memory: the built-in category is selected, so the empty state that matters is the note list —
  // it has to say what to do, not just show a count of zero.
  settings = await openSettingsPanel(page, 'Memory')
  await expect(settings.getByText('No notes yet.')).toBeVisible()
  await expect(
    settings.getByText('Write the first note above and press Enter to save it.')
  ).toBeVisible()
  await settings.getByRole('button', { name: 'Close settings' }).click()

  // Storage: a fresh profile either explains what will fill it up or shows what already does — the
  // panel is never blank. Which one appears depends on whether anything has been written yet, so both
  // legitimate states are accepted here.
  settings = await openSettingsPanel(page, 'Storage')
  const storageText = (await settings.innerText()).replace(/\s+/g, ' ')
  expect(storageText).toMatch(
    /Storage fills up as you download models|Artifacts|Uploads|Runtime|Notebooks/
  )
  await settings.getByRole('button', { name: 'Close settings' }).click()

  // A project that holds nothing: the sidebar says why it is empty and which control starts one.
  await createProject(page)
  await expect(page.getByText('No conversations yet')).toBeVisible()
  await expect(
    page.getByText('Use New above to start one, or open a project from the library.')
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start a conversation' })).toBeVisible()

  // …and with a project that holds nothing, the palette names that emptiness instead of leaving the
  // result area white. (It is the other empty state: the project exists, its lists are just empty.)
  await page.getByRole('button', { name: 'All projects' }).click()
  palette = await openPalette(page)
  await expect(palette.getByText('Nothing to browse yet')).toBeVisible()
  await expect(
    palette.getByText(
      'Type above to search your sessions and artifacts, or start a conversation in the workspace.'
    )
  ).toBeVisible()
})
