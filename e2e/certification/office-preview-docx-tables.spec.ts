import { expect } from '@playwright/test'
import type { FrameLocator } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for H2 on a real window: the fixture writes a DOCX whose tables declare a heavy frame plus
// a hairline grid, and a second table that declares rules only between its cells. The preview must draw
// what the file says — inner rules at the authored weight and kind, the frame kept apart from them, and
// no invented outline on a table that has none. The measured symptom this replaces: every cell carried
// the frame's rule on all four edges, and an inner-only table rendered with no rules at all.

test.setTimeout(240_000)

type Edge = 'Top' | 'Right' | 'Bottom' | 'Left'

type RenderedEdge = {
  style: string
  widthPx: number
  color: string
}

const readEdge = async (
  frame: FrameLocator,
  table: number,
  row: number,
  column: number,
  edge: Edge
): Promise<RenderedEdge> => {
  const cell = frame.locator('table').nth(table).locator('tr').nth(row).locator('td').nth(column)
  return cell.evaluate((element, side) => {
    const style = getComputedStyle(element)
    const read = (suffix: string): string =>
      style.getPropertyValue(`border-${side.toLowerCase()}-${suffix}`)
    return {
      style: read('style'),
      widthPx: Number.parseFloat(read('width')),
      color: read('color')
    }
  }, edge)
}

test('draws a DOCX table frame and its inner grid as the file declares them', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'DOCX table fidelity')
  await sendPrompt(page, 'Create a table DOCX fixture.', 'Table DOCX ready for session', 120_000)

  await page
    .getByRole('button', { name: /^Preview generated file table-fidelity\.docx$/ })
    .first()
    .click()
  await expect(page.getByTestId('preview-card')).toBeVisible()

  const frame = page.frameLocator('[data-office-preview-frame]')
  await expect(frame.locator('table')).toHaveCount(2)

  // Table 1 — frame: double 3pt green; inner grid: single 0.5pt grey.
  const frameTop = await readEdge(frame, 0, 0, 0, 'Top')
  const innerRight = await readEdge(frame, 0, 0, 0, 'Right')
  const innerBottom = await readEdge(frame, 0, 0, 0, 'Bottom')
  const farFrameBottom = await readEdge(frame, 0, 1, 1, 'Bottom')
  const farInnerLeft = await readEdge(frame, 0, 1, 1, 'Left')

  // Table 2 — rules only between cells, so no outline may appear on any of the four sides. "Absent" is
  // read as *drawn width*, not as the `border-*-style` keyword: the renderer composes a zero-width
  // `solid` border on cells that declare none, so the keyword alone would call an invisible rule a
  // visible one (measured: `style solid / width 0`).
  const innerOnlyRight = await readEdge(frame, 1, 0, 0, 'Right')
  const outline = {
    top: await readEdge(frame, 1, 0, 0, 'Top'),
    left: await readEdge(frame, 1, 0, 0, 'Left'),
    right: await readEdge(frame, 1, 1, 1, 'Right'),
    bottom: await readEdge(frame, 1, 1, 1, 'Bottom'),
    innerBottom: await readEdge(frame, 1, 0, 0, 'Bottom')
  }

  console.log(
    `[h2] frame=${JSON.stringify(frameTop)} inner=${JSON.stringify(innerRight)} ` +
      `innerH=${JSON.stringify(innerBottom)} farFrame=${JSON.stringify(farFrameBottom)} ` +
      `innerOnly=${JSON.stringify(innerOnlyRight)} outline=${JSON.stringify(outline)}`
  )

  // The frame is the doubled green rule the file declares.
  expect(frameTop.style).toBe('double')
  expect(frameTop.color).toBe('rgb(0, 170, 0)')
  expect(farFrameBottom.style).toBe('double')
  expect(farFrameBottom.color).toBe('rgb(0, 170, 0)')

  // The inner grid is the single grey hairline — not the frame's weight, which is what it used to be.
  expect(innerRight.style).toBe('solid')
  expect(innerRight.color).toBe('rgb(153, 153, 153)')
  expect(innerBottom.style).toBe('solid')
  expect(innerBottom.color).toBe('rgb(153, 153, 153)')
  expect(farInnerLeft.style).toBe('solid')
  expect(farInnerLeft.color).toBe('rgb(153, 153, 153)')
  // 外框必须比内网格重 —— 这是这条断言真正要说的事。**不**断言倍数：CSS 像素宽度随预览的缩放走，
  // 本机量到 3.21 vs 0.80（4×），CI runner 上量到 3.89 vs 1.95（恰好 2×，`>` 就假红了）。
  expect(frameTop.widthPx).toBeGreaterThan(innerRight.widthPx)

  // A table that declares rules only between cells draws the dotted grid and no outline on any side.
  expect(outline.top.widthPx).toBe(0)
  expect(outline.left.widthPx).toBe(0)
  expect(outline.right.widthPx).toBe(0)
  expect(outline.bottom.widthPx).toBe(0)
  expect(innerOnlyRight.style).toBe('dotted')
  expect(innerOnlyRight.color).toBe('rgb(255, 0, 255)')
  expect(innerOnlyRight.widthPx).toBeGreaterThan(0)
  expect(outline.innerBottom.style).toBe('dotted')
  expect(outline.innerBottom.widthPx).toBeGreaterThan(0)
})
