import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// Acceptance for the citation-style layer, on a real window with the real IPC surface (the fixture
// gives the app an isolated user-data root and storage root, so nothing here touches real data).
//
// It covers the path a researcher actually takes: import a style document, see the licence and the
// fidelity verdict it came with, render the same record in several styles side by side, and export the
// list in the chosen style.
//
// The CSL document is generated here rather than checked in: the fixture must not carry a third
// party's style file, and a hand-written document with a known verdict is a better assertion target.

const STYLE_DOCUMENT = `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
  <info>
    <title>PureScience Acceptance Style</title>
    <id>http://example.org/styles/acceptance</id>
    <updated>2026-09-20T00:00:00+00:00</updated>
    <rights license="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</rights>
  </info>
  <citation><layout><text variable="citation-number" prefix="[" suffix="]"/></layout></citation>
  <bibliography>
    <layout suffix=".">
      <text macro="author" suffix=". "/>
      <text variable="title" suffix=". "/>
      <text variable="container-title" suffix=" "/>
      <group delimiter=", ">
        <text variable="volume"/>
        <text variable="page"/>
      </group>
      <date variable="issued" prefix=" (" suffix=")"><date-part name="year"/></date>
    </layout>
  </bibliography>
  <macro name="author">
    <names variable="author">
      <name name-as-sort-order="all" and="text" initialize-with=". " delimiter=", "/>
    </names>
  </macro>
</style>`

const writeStyleFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'purescience-csl-'))
  const path = join(dir, 'acceptance.csl')
  writeFileSync(path, STYLE_DOCUMENT, 'utf8')
  return path
}

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Citation acceptance project')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

test('imports a CSL style, renders one record in several styles, and exports in the chosen one', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByTestId('workspace-references-toggle').click()
  const library = page.getByRole('dialog', { name: 'Reference library' })
  await expect(library).toBeVisible()

  // The style picker speaks the interface language. This window is English, so every built-in style is
  // named by its English catalogue label — the Chinese field of the same definition must not appear
  // (it used to, for all nine built-ins, in every non-Chinese interface).
  const styleOptions = library.getByLabel('Citation style').locator('option')
  await expect(styleOptions.filter({ hasText: 'APA 7th' })).toHaveCount(1)
  await expect(styleOptions.filter({ hasText: 'GB/T 7714-2015 (numeric)' })).toHaveCount(1)
  await expect(styleOptions.filter({ hasText: 'APA 第 7 版' })).toHaveCount(0)

  // A record to cite: the manual add path needs only a title.
  await library.getByRole('button', { name: 'Manual add' }).click()
  await library.getByPlaceholder('Title (required)').fill('Deep learning for protein design')
  await library.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(library.getByText('Deep learning for protein design').first()).toBeVisible()

  // Import the style document through the real file input.
  await library.getByLabel('Import CSL style').setInputFiles(writeStyleFile())
  // The style lands with its licence and its fidelity verdict — both are what a reader must see.
  await expect(library.getByText(/Imported style: PureScience Acceptance Style/)).toBeVisible()
  await expect(
    library.getByText(/creativecommons\.org\/licenses\/by-sa\/3\.0/).first()
  ).toBeVisible()

  // Select the imported style, then compare all styles side by side for the same record.
  await library.getByLabel('Citation style').selectOption({ label: 'PureScience Acceptance Style' })
  await library.getByRole('button', { name: 'Compare styles' }).first().click()
  const comparison = library.getByText('Same record, several styles')
  await expect(comparison).toBeVisible()
  // Scoped to the comparison list: the style picker carries the same names, so an unscoped lookup would
  // match the picker first (or refuse as ambiguous) instead of saying anything about the comparison.
  const comparisonList = library.getByTestId('citation-style-comparison')
  await expect(comparisonList.getByText('APA 7th')).toHaveCount(1)
  await expect(comparisonList.getByText('GB/T 7714-2015 (numeric)')).toHaveCount(1)

  // Export in the imported style and read the confirmation back, which names the style it used. The
  // button itself names the format it will write, so locating it by that name also proves the picker
  // drives the export rather than a fixed phrase.
  await library.getByRole('button', { name: 'Export as PureScience Acceptance Style' }).click()
  await expect(
    library.getByText(/Exported 1 citations in PureScience Acceptance Style/)
  ).toBeVisible()
})
