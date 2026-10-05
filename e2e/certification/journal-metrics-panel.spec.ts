import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Acceptance for the journal metrics panel's two promises, read off the real window rather than off the pure
// view the panel draws from:
//   * every number on screen carries the year and the source it came from — a bare "64.8" is what this rule
//     exists to prevent;
//   * a metric nobody imported reads "Unknown" in words. Never 0, never blank: a zero would be a claim about
//     the journal, and blank would be indistinguishable from "the panel failed to load".
// The library is seeded through the app's own bridge (the same `importJournalMetrics` call the surface
// exposes), not by poking the database, so what is measured is the path a user's import takes.

test.setTimeout(240_000)

const seed = {
  rows: [
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'impact-factor',
      value: '64.8',
      year: 2023,
      source: 'Journal Citation Reports'
    },
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'impact-factor',
      value: '62.1',
      year: 2022,
      source: 'Journal Citation Reports'
    },
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'cas-partition',
      value: '一区',
      year: 2024,
      source: '中科院文献情报中心'
    },
    {
      issn: '2041-1723',
      journalName: 'Nature Communications',
      kind: 'impact-factor',
      value: '16.6',
      year: 2023,
      source: 'Journal Citation Reports'
    }
  ]
}

test('the metrics panel names year and source, and says Unknown where a metric is missing', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal metrics panel')

  const importResult = await page.evaluate(async (payload) => {
    const bridge = globalThis as unknown as {
      api: {
        references: {
          importJournalMetrics: (
            input: unknown
          ) => Promise<{ imported: number; skipped: number; journalsCreated: number }>
          listJournalMetrics: () => Promise<{ journals: unknown[]; claims: unknown[] }>
        }
      }
    }
    const result = await bridge.api.references.importJournalMetrics(payload)
    const library = await bridge.api.references.listJournalMetrics()

    return { result, journals: library.journals.length, claims: library.claims.length }
  }, seed)

  console.log(`[panel-reading] import: ${JSON.stringify(importResult)}`)
  expect(importResult.result.imported).toBe(4)
  expect(importResult.result.skipped).toBe(0)

  // The brand blue is a claim about this product's own palette, so it is read as a NUMBER off the running
  // window instead of trusted from the stylesheet. Chromium serializes `oklch()` as written, so the computed
  // style alone proves only the token text; painting it on a canvas and reading the pixel is what proves the
  // bytes a button actually shows. Tolerance is ±2 per channel for rounding.
  const palette = await page.evaluate(() => {
    const paint = (token: string): string => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = token
      document.body.appendChild(probe)
      const computed = getComputedStyle(probe).backgroundColor
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext('2d')
      if (!context) {
        probe.remove()
        return 'n/a'
      }
      context.fillStyle = computed
      context.fillRect(0, 0, 1, 1)
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data
      probe.remove()
      return `rgb(${r}, ${g}, ${b})`
    }

    // A real primary button in the live window, so the metrics below are the ones a user's eye actually reads.
    // It is FOUND by its painted background rather than by a test id: the button this reading is about is
    // "whichever one the app paints with the brand colour", and that must not depend on which dialog happens to
    // be open when the probe runs.
    const primaryComputed = getComputedStyle(document.documentElement)
      .getPropertyValue('--primary')
      .trim()

    return {
      primary: { token: primaryComputed, painted: paint('var(--primary)') },
      foreground: {
        token: getComputedStyle(document.documentElement)
          .getPropertyValue('--primary-foreground')
          .trim(),
        painted: paint('var(--primary-foreground)')
      }
    }
  })
  console.log(
    `[panel-reading] --primary token: ${palette.primary.token} → paints as: ${palette.primary.painted}`
  )
  console.log(
    `[panel-reading] --primary-foreground token: ${palette.foreground.token} → paints as: ${palette.foreground.painted}`
  )
  const [r, g, b] = (palette.primary.painted.match(/\d+/g) ?? []).map(Number)
  expect(Math.abs(r - 77)).toBeLessThanOrEqual(2)
  expect(Math.abs(g - 107)).toBeLessThanOrEqual(2)
  expect(Math.abs(b - 254)).toBeLessThanOrEqual(2)

  // WCAG contrast of the text a primary button actually paints on its own background. Measured, not asserted
  // from taste: sRGB → relative luminance → (Lmax+0.05)/(Lmin+0.05). The floors are the WCAG 2.x AA
  // thresholds, large text (3.0) and body text (4.5); a real CTA's typography (read below, once one is on
  // screen) decides which one applies.
  const contrast = await page.evaluate(
    ({ fg, bg }) => {
      const parse = (value: string): number[] => (value.match(/\d+/g) ?? []).map(Number).slice(0, 3)
      const luminance = (rgb: number[]): number => {
        const [r, g, b] = rgb.map((channel) => {
          const c = channel / 255
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const a = luminance(parse(fg))
      const bb = luminance(parse(bg))
      return (Math.max(a, bb) + 0.05) / (Math.min(a, bb) + 0.05)
    },
    { fg: palette.foreground.painted, bg: palette.primary.painted }
  )
  console.log(`[panel-reading] primary-text contrast: ${contrast.toFixed(3)}:1`)

  // Into the library through its own toggle, then the panel through its own button.
  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const metricsToggle = dialog.getByRole('button', { name: 'Journal metrics' })
  await expect(metricsToggle).toBeVisible()
  await metricsToggle.click()
  // A picture of the state the number describes: the panel open, with the primary-coloured toggle pressed.
  await page.screenshot({ path: 'docs/evidence/2026-10-03-primary-brand-blue.png' })

  const table = dialog.locator('table')
  await expect(table).toBeVisible()

  // Now that a primary CTA is on screen, read its real typography and finish the contrast verdict: the WCAG
  // floor depends on whether the text counts as large (≥24px, or ≥18.66px at weight ≥700).
  const cta = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>(
      '[data-slot="journal-metrics-import-submit"]'
    )
    if (!button) return null
    const style = getComputedStyle(button)
    return {
      fontSizePx: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseInt(style.fontWeight, 10),
      label: (button.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    }
  })
  console.log(`[panel-reading] primary CTA typography: ${JSON.stringify(cta)}`)
  expect(cta).not.toBeNull()
  const ctaIsLargeText =
    cta !== null && (cta.fontSizePx >= 24 || (cta.fontSizePx >= 18.66 && cta.fontWeight >= 700))
  const floor = ctaIsLargeText ? 3 : 4.5
  console.log(
    `[panel-reading] primary-text verdict: ${contrast.toFixed(3)}:1 ` +
      `${contrast >= floor ? 'meets' : 'falls short of'} the ${floor} floor ` +
      `(${ctaIsLargeText ? 'large' : 'body'} text at ${cta?.fontSizePx}px/${cta?.fontWeight})`
  )
  // A floor, not the current value: raising the ratio is allowed, dropping below it is a regression.
  // Light theme measures 4.144:1 — above the large-text floor, below the body-text floor, and whitening the
  // foreground cannot close the gap (pure white on this blue is 4.330:1, the ceiling for this background).
  // The brand blue is a product decision, so the gap is recorded rather than silently patched:
  // docs/evidence/2026-10-03-primary-contrast.md carries the numbers and the two ways to close it.
  expect(contrast).toBeGreaterThanOrEqual(3)

  // Nature's latest impact factor is on screen WITH its year and its source — all three in one row's text.
  const natureRow = table.locator('tr', { hasText: 'nature' }).first()
  const natureText = (await natureRow.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] nature row: ${natureText}`)
  // The row shows the source's own spelling, not the normalized form: `nature` on screen would mean the
  // record's display name was never read (R2-U4 reads it; before that the panel could only show the fold).
  expect(natureText.startsWith('Nature ')).toBe(true)
  expect(natureText).toContain('64.8')
  expect(natureText).toContain('2023')
  expect(natureText).toContain('Journal Citation Reports')
  expect(natureText).toContain('一区')
  expect(natureText).toContain('中科院文献情报中心')

  // The kind nobody imported for Nature reads "Unknown" in words — and the row that carries it is not a zero.
  expect(natureText.toLowerCase()).toContain('unknown')
  const metricCells = table.locator('tbody td')
  const cellTexts = (await metricCells.allInnerTexts()).map((text) =>
    text.replace(/\s+/g, ' ').trim()
  )
  console.log(`[panel-reading] cells: ${JSON.stringify(cellTexts)}`)
  expect(cellTexts).not.toContain('0')
  expect(cellTexts.some((text) => text.startsWith('64.8') && text.includes('2023'))).toBe(true)

  // Nature Communications is a different journal with its own number — the panel is not showing one row twice.
  const communicationsRow = table.locator('tr', { hasText: 'nature communications' }).first()
  const communicationsText = (await communicationsRow.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] nature communications row: ${communicationsText}`)
  expect(communicationsText).toContain('16.6')
  expect(communicationsText).not.toContain('64.8')

  // The filter controls, read off the same window: partition, impact-factor floor, year. The panel's own
  // promise here is that a filter that matches nothing says so, and that a year-restricted view does not
  // borrow a figure from another year.
  const rows = async (): Promise<string[]> =>
    (await table.locator('tbody tr').allInnerTexts()).map((text) =>
      text.replace(/\s+/g, ' ').trim()
    )

  await dialog.getByLabel('Partition').selectOption('一区')
  const partitionRows = await rows()
  console.log(`[panel-reading] partition=一区 rows: ${JSON.stringify(partitionRows)}`)
  expect(partitionRows).toHaveLength(1)
  expect(partitionRows[0]).toContain('Nature')
  expect(partitionRows.join(' ')).not.toContain('16.6')

  await dialog.getByLabel('Partition').selectOption('')
  await dialog.getByLabel('Impact factor ≥').fill('999')
  const emptyNotice = dialog.getByText('No journal matches this filter.')
  await expect(emptyNotice).toBeVisible()
  console.log(`[panel-reading] empty-filter notice: ${(await emptyNotice.innerText()).trim()}`)
  expect(await table.locator('tbody tr').count()).toBe(0)

  await dialog.getByLabel('Impact factor ≥').fill('')
  // Scoped to the filter region: the correction form further down this panel has its own "Year" field, and an
  // unscoped lookup resolves to both.
  const filters = dialog.getByTestId('journal-metrics-filters')
  await filters.getByLabel('Year').fill('2022')
  const yearRows = await rows()
  console.log(`[panel-reading] year=2022 rows: ${JSON.stringify(yearRows)}`)
  const natureIn2022 = yearRows.find((text) => text.startsWith('Nature')) ?? ''
  expect(natureIn2022).toContain('62.1')
  expect(natureIn2022).toContain('2022')
  // The 2024 partition claim does not belong to 2022, so that cell falls back to Unknown instead of showing
  // a figure from another year — and Nature Communications has nothing in 2022 at all.
  expect(natureIn2022).toContain('Unknown')
  expect(yearRows.join(' ')).not.toContain('64.8')
  expect(yearRows.join(' ')).not.toContain('16.6')

  // IC28: the ceiling of the same range. The store carried both bounds, but only the floor was ever reachable
  // from the window — so a reader could not ask "which journals are at most X", the question a submission
  // shortlist is usually about. A positive assertion, not just the empty notice: with a ceiling of 20 the
  // 16.6 journal must survive and the 64.8 one must not.
  await filters.getByLabel('Year').fill('')
  await dialog.getByLabel('Impact factor ≤').fill('20')
  const ceilingRows = await rows()
  console.log(`[panel-reading] impact factor ≤ 20 rows: ${JSON.stringify(ceilingRows)}`)
  expect(ceilingRows).toHaveLength(1)
  expect(ceilingRows[0]).toContain('Nature Communications')
  expect(ceilingRows[0]).toContain('16.6')
  expect(ceilingRows.join(' ')).not.toContain('64.8')

  await dialog.getByLabel('Impact factor ≤').fill('1')
  await expect(dialog.getByText('No journal matches this filter.')).toBeVisible()
  expect(await table.locator('tbody tr').count()).toBe(0)
  await dialog.getByLabel('Impact factor ≤').fill('')
})

// The alias/merge reading (R2-U4), taken off the same real window: two spellings that LOOK alike start life as
// two journals (nothing merges similar names behind the reader's back), the user's explicit merge folds them
// into one row, and the spelling that was merged away stays visible as an alias so the surviving row can be
// read without wondering where the other number came from. The refusal branches are covered where they can be
// built honestly — the panel's own render suite drives a refusal result into the control, because the states
// that trigger them (a hand-written row, an id deleted under the window) cannot be produced by clicking.
const mergeSeed = {
  rows: [
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'impact-factor',
      value: '64.8',
      year: 2023,
      source: 'Journal Citation Reports'
    },
    {
      issn: '2041-1723',
      journalName: 'Nature Communications',
      kind: 'impact-factor',
      value: '16.6',
      year: 2023,
      source: 'Journal Citation Reports'
    }
  ]
}

test('an explicit merge folds two journals into one row and keeps the old spelling as an alias', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal merge panel')

  const before = await page.evaluate(async (payload) => {
    const bridge = globalThis as unknown as {
      api: {
        references: {
          importJournalMetrics: (
            input: unknown
          ) => Promise<{ imported: number; skipped: number; journalsCreated: number }>
          listJournalMetrics: () => Promise<{
            journals: Array<{ id: string; normalizedName: string; displayName?: string | null }>
            aliases: unknown[]
          }>
        }
      }
    }
    const result = await bridge.api.references.importJournalMetrics(payload)
    const library = await bridge.api.references.listJournalMetrics()

    return {
      result,
      journals: library.journals.map((journal) => ({
        id: journal.id,
        normalizedName: journal.normalizedName,
        displayName: journal.displayName ?? null
      })),
      aliases: library.aliases.length
    }
  }, mergeSeed)

  console.log(`[panel-reading] merge seed: ${JSON.stringify(before)}`)
  expect(before.result.imported).toBe(2)
  // Two spellings, two journals, zero aliases: similarity alone merged nothing.
  expect(before.journals).toHaveLength(2)
  expect(before.aliases).toBe(0)

  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Journal metrics' }).click()

  const table = dialog.locator('table')
  await expect(table).toBeVisible()
  await expect(table.locator('tbody tr')).toHaveCount(2)

  // The source's own spelling is what the row shows — `nature` (the normalized form) would mean the record's
  // display name was never read.
  const firstRow = (await table.locator('tbody tr').first().innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] row before merge: ${firstRow}`)
  expect(firstRow).toContain('Nature')
  await expect(dialog.locator('[data-slot="journal-alias"]')).toHaveCount(0)

  const confirm = dialog.locator('[data-slot="journal-merge-confirm"]')
  await expect(confirm).toBeDisabled()
  await dialog
    .locator('[data-slot="journal-merge-source"]')
    .selectOption({ label: 'Nature Communications' })

  // --- The intermediate state, read rather than assumed: one side chosen, nothing sent. ----------------
  const halfState = await dialog.evaluate((root) => {
    const read = (slot: string): { value: string; label: string } => {
      const select = root.querySelector<HTMLSelectElement>(`[data-slot="${slot}"]`)
      return {
        value: select?.value ?? 'missing',
        label: select?.selectedOptions[0]?.textContent?.trim() ?? 'missing'
      }
    }
    const confirmButton = root.querySelector<HTMLButtonElement>(
      '[data-slot="journal-merge-confirm"]'
    )
    return {
      source: read('journal-merge-source'),
      target: read('journal-merge-target'),
      confirmDisabled: confirmButton?.disabled ?? null,
      reportedResults: root.querySelectorAll('[data-slot="journal-merge-result"]').length
    }
  })
  console.log(`[panel-reading] merge intermediate (one side): ${JSON.stringify(halfState)}`)
  expect(halfState.source.label).toBe('Nature Communications')
  expect(halfState.target.value).toBe('')
  expect(halfState.confirmDisabled).toBe(true)
  expect(halfState.reportedResults).toBe(0)

  await dialog.locator('[data-slot="journal-merge-target"]').selectOption({ label: 'Nature' })

  // Both sides chosen, still NOT confirmed: the control is armed, and the library is untouched — the state a
  // user sits in while deciding. Read together with the store, because "the button lit up" and "something was
  // written" are different claims.
  const armedState = await dialog.evaluate((root) => {
    const read = (slot: string): string =>
      root
        .querySelector<HTMLSelectElement>(`[data-slot="${slot}"]`)
        ?.selectedOptions[0]?.textContent?.trim() ?? 'missing'
    const confirmButton = root.querySelector<HTMLButtonElement>(
      '[data-slot="journal-merge-confirm"]'
    )
    return {
      source: read('journal-merge-source'),
      target: read('journal-merge-target'),
      confirmDisabled: confirmButton?.disabled ?? null,
      reportedResults: root.querySelectorAll('[data-slot="journal-merge-result"]').length
    }
  })
  const libraryBeforeConfirm = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        references: {
          listJournalMetrics: () => Promise<{ journals: unknown[]; aliases: unknown[] }>
        }
      }
    }
    const library = await bridge.api.references.listJournalMetrics()
    return { journals: library.journals.length, aliases: library.aliases.length }
  })
  console.log(`[panel-reading] merge intermediate (armed): ${JSON.stringify(armedState)}`)
  console.log(`[panel-reading] library before confirm: ${JSON.stringify(libraryBeforeConfirm)}`)
  expect(armedState.source).toBe('Nature Communications')
  expect(armedState.target).toBe('Nature')
  expect(armedState.confirmDisabled).toBe(false)
  expect(armedState.reportedResults).toBe(0)
  // Arming is not acting: two journals, still no alias, and no result line yet.
  expect(libraryBeforeConfirm).toEqual({ journals: 2, aliases: 0 })
  await expect(confirm).toBeEnabled()

  const result = dialog.locator('[data-slot="journal-merge-result"]')
  await expect(result).toHaveCount(0)
  await confirm.click()
  await expect(result).toBeVisible()
  const resultText = (await result.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] merge result: ${resultText}`)
  // The report names what moved and the spelling that now resolves to the survivor.
  expect(resultText).toContain('1')
  expect(resultText).toContain('nature communications')

  // The table was re-read: one row remains, and the old spelling is on screen as an alias rather than
  // silently gone.
  await expect(table.locator('tbody tr')).toHaveCount(1)
  const mergedRow = (await table.locator('tbody tr').first().innerText())
    .replace(/\s+/g, ' ')
    .trim()
  console.log(`[panel-reading] row after merge: ${mergedRow}`)
  expect(mergedRow).toContain('Nature')
  // Two claims for 2023 now live on this journal, and BOTH are printed: the selected one first, the one it
  // would otherwise hide beside it with its own source (V11/IC1). Before that change this row carried a single
  // number and this comment said so; the read-back below still shows the store keeps both.
  expect(mergedRow).toContain('16.6')
  expect(mergedRow).toContain('64.8')
  expect(mergedRow).toContain('Journal Citation Reports')
  await expect(dialog.locator('[data-testid="journal-metric-conflict"]')).toBeVisible()
  const aliasNote = dialog.locator('[data-slot="journal-alias"]')
  await expect(aliasNote).toBeVisible()
  const aliasText = (await aliasNote.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] alias note: ${aliasText}`)
  expect(aliasText).toContain('nature communications')

  // And the store itself, read back through the same bridge the panel reads with: one journal, the old
  // spelling recorded as its alias, and BOTH claims now hanging off the survivor.
  const survivorId =
    before.journals.find((journal) => journal.normalizedName === 'nature')?.id ?? ''
  const after = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        references: {
          listJournalMetrics: () => Promise<{
            journals: Array<{ id: string; normalizedName: string }>
            claims: Array<{ journalId: string; value: string }>
            aliases: Array<{ normalizedName: string; journalId: string }>
          }>
        }
      }
    }
    const library = await bridge.api.references.listJournalMetrics()

    return {
      journals: library.journals.map((journal) => journal.normalizedName),
      aliases: library.aliases.map((alias) => alias.normalizedName),
      aliasTarget: library.aliases[0]?.journalId ?? null,
      claims: library.claims.map((claim) => ({ journalId: claim.journalId, value: claim.value }))
    }
  })
  console.log(`[panel-reading] library after merge: ${JSON.stringify(after)}`)
  expect(after.journals).toEqual(['nature'])
  expect(after.aliases).toEqual(['nature communications'])
  expect(after.aliasTarget).toBe(survivorId)
  expect(after.claims.map((claim) => claim.value).sort()).toEqual(['16.6', '64.8'])
  expect(after.claims.every((claim) => claim.journalId === survivorId)).toBe(true)

  // The control stayed mounted to show that report, but with one journal left it cannot act: the button is
  // inert rather than offering to merge a journal that no longer exists. (Before this reading the panel
  // unmounted the whole block on success, which swallowed the report the user had just asked for.)
  await expect(dialog.getByText('Merge two journals')).toBeVisible()
  await expect(confirm).toBeDisabled()
})

// The import affordance (the surface that used to exist only as an application command): pasting a publisher
// table must produce a PER-ROW outcome — the good row stored, the refused row named — read off the real window.
// One row deliberately has no year: "a metric without a year is not a fact" is the rule this reading is for.
test('the import entry stores the good row and names the refused one', async ({ app }) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal metrics import')

  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Journal metrics' }).click()

  const csv = [
    'journal,issn,kind,value,year,source',
    'Nature,0028-0836,impact-factor,64.8,2023,Journal Citation Reports',
    'Nature Communications,2041-1723,impact-factor,16.6,,Journal Citation Reports'
  ].join('\n')
  await dialog.getByLabel('Import metrics').fill(csv)
  await dialog.locator('[data-slot="journal-metrics-import-submit"]').click()

  const summary = dialog.locator('[data-slot="journal-metrics-import-summary"]')
  await expect(summary).toBeVisible()
  const summaryText = (await summary.innerText()).replace(/\s+/g, ' ').trim()
  const importedLines = (
    await dialog.locator('[data-slot="journal-metrics-import-imported"]').allInnerTexts()
  ).map((text) => text.replace(/\s+/g, ' ').trim())
  const skippedLines = (
    await dialog.locator('[data-slot="journal-metrics-import-skipped"]').allInnerTexts()
  ).map((text) => text.replace(/\s+/g, ' ').trim())
  console.log(`[panel-reading] import summary: ${summaryText}`)
  console.log(`[panel-reading] import imported rows: ${JSON.stringify(importedLines)}`)
  console.log(`[panel-reading] import skipped rows: ${JSON.stringify(skippedLines)}`)

  // One row stored, one refused — and the refusal says WHICH row and WHY, not just that something failed.
  expect(importedLines).toHaveLength(1)
  expect(importedLines[0]).toContain('64.8')
  expect(skippedLines).toHaveLength(1)
  expect(skippedLines[0].toLowerCase()).toContain('no year')

  // The table above now shows what the import stored, because the panel re-read the library.
  const table = dialog.locator('table')
  await expect(table.locator('tr', { hasText: 'Nature' }).first()).toBeVisible()
})

// V11 (IC1). A merge can leave two claims for the SAME kind and year. Before this, the screen printed the one
// with the newer `fetchedAt` and said nothing, so a reader could not know the year held a second value from a
// second source (found on the real machine while reading the merge in R2-U4). The import in the test above is
// idempotent for identical rows, but a DIFFERENT value for the same year is a second fact — so this walks the
// user path to build one and reads the window.
const contestedSeed = {
  rows: [
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'impact-factor',
      value: '64.8',
      year: 2023,
      source: 'Journal Citation Reports'
    },
    {
      issn: '0028-0836',
      journalName: 'Nature',
      kind: 'impact-factor',
      value: '16.6',
      year: 2023,
      source: 'CAS journal metrics'
    }
  ]
}

test('one year with two claims shows both values, each with its own source', async ({ app }) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Journal metric conflict')

  const importResult = await page.evaluate(async (payload) => {
    const bridge = globalThis as unknown as {
      api: {
        references: {
          importJournalMetrics: (
            input: unknown
          ) => Promise<{ imported: number; skipped: number; journalsCreated: number }>
          listJournalMetrics: () => Promise<{ journals: unknown[]; claims: unknown[] }>
        }
      }
    }
    const result = await bridge.api.references.importJournalMetrics(payload)
    const library = await bridge.api.references.listJournalMetrics()

    // The store really holds two rows for that year — the assertion below is about the window, and this
    // reading is what makes the window's two values a fact rather than a rendering accident.
    return { result, claims: library.claims.length, journals: library.journals.length }
  }, contestedSeed)
  console.log(`[panel-reading] contested import: ${JSON.stringify(importResult)}`)
  expect(importResult.result.imported).toBe(2)
  expect(importResult.claims).toBe(2)

  await page.getByTestId('workspace-references-toggle').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Journal metrics' }).click()

  const table = dialog.locator('table')
  await expect(table).toBeVisible()
  const row = table.locator('tr', { hasText: 'Nature' }).first()
  const rowText = (await row.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] contested row: ${rowText}`)

  // Both facts are on screen, each with its own source: neither value is dropped for the other.
  expect(rowText).toContain('64.8')
  expect(rowText).toContain('16.6')
  expect(rowText).toContain('Journal Citation Reports')
  expect(rowText).toContain('CAS journal metrics')

  // And the conflict is marked, so the second value cannot be mistaken for an extra column.
  const marker = row.locator('[data-testid="journal-metric-conflict"]')
  await expect(marker).toBeVisible()
  const markerText = (await marker.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[panel-reading] conflict marker: ${markerText}`)
  expect(row.locator('[data-testid="journal-metric-alternative"]')).toHaveCount(1)
  await page.screenshot({ path: 'docs/evidence/2026-10-03-journal-metric-conflict.png' })
})
