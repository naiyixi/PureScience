import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// Real-window acceptance: the connector import panel speaks the reader's language.
//
// The parser composes one canonical English sentence per diagnostic code — that sentence is what the log
// and the parser's own tests carry, and before this unit it was also what the panel printed, so a reader
// whose interface is Chinese was handed English error rows. The panel now assembles the sentence from the
// code plus the values the parser attached, in the reader's language.
//
// Both halves are read here, on a real window driven through the real entry (Settings → Connectors →
// Add connector → Import configuration), with a real file dropped on the real drop zone:
//   the row on screen is the dictionary's Traditional Chinese sentence, filled with the parser's own
//   values, and the canonical English sentence is not on screen at all.
// A pass that only checked "some text appeared" would also pass if the panel never translated anything,
// which is why the English sentence is asserted absent rather than left unchecked.

// `name` is capped at 128 characters by the parser; a 200-character name produces exactly one diagnostic.
const NAME_MAX = 128
const NAME_TOO_LONG_ZH_HANT = `name 超過 ${NAME_MAX} 個字元。`
const NAME_TOO_LONG_EN = `name exceeds ${NAME_MAX} characters.`

const INVALID_TEMPLATE = JSON.stringify({
  schemaVersion: 1,
  kind: 'purescience.connector',
  name: 'a'.repeat(200),
  transport: 'stdio',
  command: 'npx'
})

test.setTimeout(180_000)

test('the import panel prints connector diagnostics in the interface language', async ({ app }) => {
  const page = await app.completeOnboarding()

  // The interface language is a preference read when the provider mounts, so it is set and the window is
  // reloaded — the same two steps a reader takes in Settings → General → Language.
  await page.evaluate(() => window.localStorage.setItem('purescience-language', 'zh-Hant'))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  const settingsButton = page.getByRole('button', { name: '設定' }).first()
  await expect(settingsButton).toBeVisible({ timeout: 60_000 })
  console.log(
    '[connector-diagnostic-language] window reloaded in zh-Hant: the Settings entry reads 設定'
  )
  await settingsButton.click()

  const settings = page.getByRole('dialog', { name: '設定' })
  await settings
    .getByRole('navigation', { name: '設定' })
    .getByRole('button', { name: /連接器/ })
    .click()

  await settings
    .getByRole('button', { name: /新增連接器/ })
    .first()
    .click()
  // The dropdown renders in a portal at the top level, so it is located from the page rather than from
  // inside the Settings dialog.
  await page.getByRole('menuitem', { name: /匯入組態/ }).click()

  const dropZone = settings.getByRole('button', { name: /拖放或按一下以選擇/ })
  await expect(dropZone).toBeVisible({ timeout: 30_000 })

  // A real file drop: the handler reads `dataTransfer.files` and the file's own text, so the bytes below
  // travel the same path a dragged file does.
  await dropZone.evaluate((element, contents) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([contents], 'invalid-connector.json', { type: 'application/json' }))
    element.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
    )
  }, INVALID_TEMPLATE)

  const diagnostics = settings.locator('[aria-label="組態診斷"]')
  await expect(diagnostics).toBeVisible({ timeout: 30_000 })
  await expect(diagnostics.getByText(NAME_TOO_LONG_ZH_HANT, { exact: true })).toBeVisible({
    timeout: 30_000
  })
  // The canonical English sentence is the one the panel used to print; if it is still on screen the row
  // was not translated, whatever else the panel shows.
  await expect(settings.getByText(NAME_TOO_LONG_EN, { exact: true })).toHaveCount(0)

  const rows = await diagnostics.locator('div.items-start').count()
  console.log(
    `[connector-diagnostic-language] rows=${rows} row="${NAME_TOO_LONG_ZH_HANT}" canonicalEnglishOnScreen=false`
  )
  expect(rows).toBe(1)
})
