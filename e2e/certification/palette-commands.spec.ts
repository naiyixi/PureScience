import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Acceptance for the palette as a command surface on a real window: ⌘K has to answer a phrase a user types
// with a COMMAND that goes somewhere, and running that command has to land on the destination with the
// palette out of the way. Finding history was never the gap — the gap was that nothing behind the palette
// moved the app.
//
// The shortcut sheet is checked here too, because "Cmd+, and Cmd+W are visible in the interface" is a claim
// about what is on screen, not about what the handlers happen to do.

test.setTimeout(180_000)

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

test('answers a palette query with a command that lands on its destination', async ({ app }) => {
  let page = await app.completeOnboarding()
  // configureFakeAgent hands back the page it ended on; keeping the earlier one loses the bridge.
  page = await app.configureFakeAgent()
  await createProject(page, 'Palette commands')

  await page.keyboard.press(`${modifier}+k`)
  const palette = page.getByTestId('global-search-dialog')
  await expect(palette).toBeVisible()

  // "mirror" is what someone looking for the download source types; the panel that owns it is called
  // Network. A command has to be reachable by what it does, not only by its label.
  await palette.getByRole('combobox').fill('mirror')
  const command = page.getByTestId('palette-command-settings.network')
  await expect(command).toBeVisible()
  await expect(command).toContainText('Network')
  await command.click()

  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()

  // Settings own the foreground now, which the app shows by no longer letting ⌘K open the palette behind
  // them — the check that the command really navigated instead of only closing the palette.
  await page.keyboard.press(`${modifier}+k`)
  await expect(page.getByTestId('global-search-dialog')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  // The shortcut sheet, reached through the same palette, has to show the chords the audit asked for.
  await page.keyboard.press(`${modifier}+k`)
  await expect(page.getByTestId('global-search-dialog')).toBeVisible()
  await page.getByTestId('global-search-dialog').getByRole('combobox').fill('keyboard shortcuts')
  await page.getByTestId('palette-command-shortcuts.open').click()

  const sheet = page.getByTestId('keyboard-shortcuts-dialog')
  await expect(sheet).toBeVisible()
  await expect(page.getByTestId('shortcut-row-settings')).toContainText(',')
  await expect(page.getByTestId('shortcut-row-close')).toContainText('W')

  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // IC51: the allowlist vocabulary reaches the panel that owns it, on both surfaces a user can query. Someone
  // typing "白名单" / "egress" is looking for the notebook network allowlist, and that panel is called Network.
  await page.keyboard.press(`${modifier}+k`)
  const paletteAgain = page.getByTestId('global-search-dialog')
  await expect(paletteAgain).toBeVisible()
  for (const query of ['白名单', 'egress', '域名']) {
    // The window holds other comboboxes; the palette's own field is the one inside its dialog.
    await paletteAgain.locator('input[role="combobox"]').first().fill(query)
    const reached = page.getByTestId('palette-command-settings.network')
    await expect(reached).toBeVisible()
    console.log(
      `[ic51] the palette answers "${query}" with: ${(await reached.innerText()).replace(/\s+/g, ' ').trim()}`
    )
  }
  await page.getByTestId('palette-command-settings.network').click()

  const settingsAgain = page.getByRole('dialog', { name: 'Settings' })
  await expect(settingsAgain).toBeVisible()
  // The panel's own search has to answer the same words — the allowlist lives inside Network.
  const settingsSearch = settingsAgain.getByRole('searchbox')
  const networkEntry = settingsAgain
    .getByRole('button', { name: 'Network', exact: true })
    .locator('visible=true')
    .first()
  for (const query of ['白名单', '域名']) {
    await settingsSearch.fill(query)
    await expect(networkEntry).toBeVisible()
    console.log(`[ic51] the settings search still lists Network for "${query}"`)
  }
})
