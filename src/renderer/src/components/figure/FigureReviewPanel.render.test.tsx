// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider } from '@/i18n'
import { FigureReviewPanel } from './FigureReviewPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The rule engine itself lives in the main process; what this suite pins is the *declaration* the surface
// hands it. Every field is optional and an omitted one stays omitted, so the panel can never claim a value
// the reader did not give — and the request it sends is the thing worth asserting, not just the rendering.

let container: HTMLDivElement
let root: Root
let review: ReturnType<typeof vi.fn>

const mount = async (result?: unknown, opts: { absent?: boolean } = {}): Promise<void> => {
  review = vi.fn().mockResolvedValue(result ?? { panels: 1, violations: [], clean: true })
  ;(window as unknown as { api: unknown }).api = opts.absent
    ? { figure: null }
    : { figure: { review } }
  await act(async () => {
    root.render(
      <LanguageProvider>
        <FigureReviewPanel
          projectId="project-1"
          sourceName="figure.png"
          onClose={() => undefined}
        />
      </LanguageProvider>
    )
  })
}

const setInput = async (testId: string, value: string): Promise<void> => {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)
  if (!input) throw new Error(`missing ${testId}`)
  // React tracks the node's value itself: assigning `.value` and dispatching `input` leaves onChange
  // unfired, so the field would silently keep its default and the request assertion would be meaningless.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const click = async (testId: string): Promise<void> => {
  const node = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!node) throw new Error(`missing ${testId}`)
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('FigureReviewPanel', () => {
  it('declares only what the reader gave, and nothing the reader left undeclared', async () => {
    await mount()
    await setInput('figure-review-series-count', '9')
    await click('figure-review-run')

    expect(review).toHaveBeenCalledTimes(1)
    const request = review.mock.calls[0][0] as {
      projectId: string
      request: { panels: Record<string, unknown>[] }
    }
    expect(request.projectId).toBe('project-1')
    const panel = request.request.panels[0]
    expect(panel.id).toBe('A')
    expect(panel.chartType).toBe('line')
    expect(panel.seriesCount).toBe(9)
    expect(panel.labelCount).toBe(4)
    expect(panel.fontPt).toBe(8)
    expect(panel.rendered).toBe(false)
    // Never declared: the reader cannot know these, so they must not be invented here.
    expect(panel.excludedRows).toBeUndefined()
    expect(panel.summaryUsedExcluded).toBeUndefined()
    expect(panel.axisTicks).toBeUndefined()
    expect(panel.renderedImagePath).toBeUndefined()
    expect(panel.sourceScriptPath).toBeUndefined()
  })

  it('shows the engine’s findings with their own rule and severity', async () => {
    await mount({
      panels: 1,
      clean: false,
      violations: [
        {
          rule: 'color-threading',
          panelId: 'A',
          severity: 'error',
          message: 'Panel A: 9 series exceeds 8 — distinct hues above ~8 are indistinguishable.'
        }
      ]
    })
    await click('figure-review-run')

    expect(container.querySelector('[data-testid="figure-review-count"]')?.textContent).toContain(
      '1'
    )
    const finding = container.querySelector<HTMLElement>(
      '[data-testid="figure-review-violation-0"]'
    )
    expect(finding?.dataset.rule).toBe('color-threading')
    expect(finding?.dataset.severity).toBe('error')
    expect(finding?.textContent).toContain('9 series exceeds 8')
    expect(container.querySelector('[data-testid="figure-review-clean"]')).toBeNull()
  })

  it('says a clean result covers only what was declared', async () => {
    await mount({ panels: 1, violations: [], clean: true })
    await click('figure-review-run')

    expect(container.querySelector('[data-testid="figure-review-clean"]')).not.toBeNull()
    // The data-handling rule cannot be answered from the picture, and the panel says so up front.
    expect(
      container.querySelector('[data-testid="figure-review-author-only"]')?.textContent
    ).toBeTruthy()
    expect(container.querySelector('[data-testid="figure-review-scope"]')?.textContent).toBeTruthy()
  })

  it('reports the channel as unavailable instead of a silent empty result', async () => {
    await mount(undefined, { absent: true })
    await click('figure-review-run')

    expect(container.querySelector('[data-testid="figure-review-failed"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="figure-review-result"]')).toBeNull()
  })
})
