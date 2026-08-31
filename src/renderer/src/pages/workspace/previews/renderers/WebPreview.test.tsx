// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The i18n hook is language-agnostic here; keep it simple by rendering through the real store-free
// component. Mock the language hook so translations resolve without wiring the full provider.
vi.mock('@/i18n', () => ({
  useLanguage: () => ({
    t: (key: string): string => {
      const labels: Record<string, string> = {
        'ws.webPreviewOpenExternal': 'Open in system browser',
        'ws.webPreviewUnsupported': 'Only HTTP(S) links can be previewed in-app.'
      }
      return labels[key] ?? key
    }
  })
}))

const { WebPreviewSurface } = await import('./WebPreview')

describe('WebPreviewSurface', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const renderSurface = (props: { url: string; title: string; isActive: boolean }): Promise<void> =>
    act(async () => {
      root.render(<WebPreviewSurface {...props} />)
    })

  it('renders the source URL in a sandboxed, no-referrer iframe', async () => {
    await renderSurface({ url: 'https://example.com/paper', title: 'Paper', isActive: true })

    const iframe = container.querySelector<HTMLIFrameElement>('iframe')
    expect(iframe?.getAttribute('src')).toBe('https://example.com/paper')
    expect(iframe?.getAttribute('sandbox')).toContain('allow-scripts')
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe?.getAttribute('title')).toBe('Paper')
  })

  it('shows the hostname and full URL in the header bar', async () => {
    await renderSurface({
      url: 'https://pubmed.ncbi.nlm.nih.gov/123',
      title: 'PubMed',
      isActive: true
    })

    expect(container.textContent).toContain('pubmed.ncbi.nlm.nih.gov')
    expect(container.textContent).toContain('https://pubmed.ncbi.nlm.nih.gov/123')
  })

  it('advances the loading indicator toward 90% while the frame loads and completes on load', async () => {
    vi.useFakeTimers()
    try {
      await renderSurface({ url: 'https://example.com/paper', title: 'Paper', isActive: true })

      const bar = container.querySelector('[role="progressbar"]')
      expect(bar).not.toBeNull()

      // Three interval ticks: 0 → 18.
      await act(async () => {
        vi.advanceTimersByTime(400 * 3)
      })

      const indicator = container.querySelector<HTMLElement>('[role="progressbar"] > div')
      const widthAfterTicks = Number(indicator?.style.width.replace('%', '') ?? 0)
      expect(widthAfterTicks).toBe(18)
      expect(widthAfterTicks).toBeLessThanOrEqual(90)

      // Completing the iframe load completes the bar: the inner indicator element unmounts (the
      // outer 2px track stays as a neutral divider, but the moving bar is gone).
      await act(async () => {
        container.querySelector<HTMLIFrameElement>('iframe')?.dispatchEvent(new Event('load'))
      })

      expect(container.querySelector('[role="progressbar"] > div')).toBeNull()
      expect(container.querySelector('[role="progressbar"]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the indicator when the URL changes', async () => {
    await renderSurface({ url: 'https://example.com/paper', title: 'Paper', isActive: true })

    const iframe = container.querySelector<HTMLIFrameElement>('iframe')
    await act(async () => {
      iframe?.dispatchEvent(new Event('load'))
    })

    await renderSurface({ url: 'https://example.com/other', title: 'Other', isActive: true })

    const newIframe = container.querySelector<HTMLIFrameElement>('iframe')
    expect(newIframe?.getAttribute('src')).toBe('https://example.com/other')
    const indicator = container.querySelector<HTMLElement>('[role="progressbar"] > div')
    expect(Number(indicator?.style.width.replace('%', '') ?? 0)).toBe(0)
  })

  it('refuses non-HTTP(S) sources with an explanatory message', async () => {
    await renderSurface({ url: 'file:///etc/passwd', title: 'Bad', isActive: true })

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('Only HTTP(S) links can be previewed in-app.')
  })

  it('opens the source in the system browser from the header action', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await renderSurface({ url: 'https://example.com/paper', title: 'Paper', isActive: true })

    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open in system browser"]'
    )
    await act(async () => {
      button?.click()
    })

    expect(open).toHaveBeenCalledWith('https://example.com/paper', '_blank', 'noreferrer')
  })
})
