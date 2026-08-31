// @vitest-environment jsdom
// Render + interaction tests for the FoldTimelinePanel (folded-context timeline).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContextSummaryChunkView } from '../../../../shared/reviewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const getChunks = vi.fn()

vi.mock('@/lib/utils', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))

Object.defineProperty(globalThis, 'window', {
  value: {
    api: {
      reviewer: { getChunks }
    }
  },
  configurable: true
})

import { FoldTimelinePanel } from './FoldTimelinePanel'

const makeChunk = (overrides: Partial<ContextSummaryChunkView>): ContextSummaryChunkView => ({
  id: 'fold-1700000000000-abc123',
  level: 1,
  foldedAt: 1_700_000_000_000,
  reason: 'automatic',
  summaryText: 'Context was compacted (automatic).',
  transcriptPreview: '[user] Filter EGFR variants for T790M\n[assistant] Querying gnomAD…',
  ...overrides
})

let container: HTMLElement
let root: Root

const renderPanel = (): void => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<FoldTimelinePanel projectId="project-1" sessionId="session-1" />)
  })
}

beforeEach(() => {
  getChunks.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('FoldTimelinePanel', () => {
  it('loads chunks for the session on mount', async () => {
    getChunks.mockResolvedValue([makeChunk({})])
    renderPanel()
    expect(getChunks).toHaveBeenCalledWith({ projectId: 'project-1', appSessionId: 'session-1' })
    await act(async () => {})
    expect(container.querySelector('[data-testid="fold-chunk"]')).not.toBeNull()
  })

  it('shows the empty state when the session has no folds', async () => {
    getChunks.mockResolvedValue([])
    renderPanel()
    await act(async () => {})
    expect(container.querySelector('[data-testid="fold-timeline-empty"]')).not.toBeNull()
    expect(container.textContent).toContain('No context folds yet')
  })

  it('renders chunk metadata: id, reason, time, boundary label', async () => {
    getChunks.mockResolvedValue([
      makeChunk({ boundaryLabel: 'finished variant filtering' }),
      makeChunk({ id: 'fold-2', level: 2, reason: 'manual', foldedAt: 1_700_100_000_000 })
    ])
    renderPanel()
    await act(async () => {})

    const chunks = container.querySelectorAll('[data-testid="fold-chunk"]')
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.textContent).toContain('fold-1700000000000-abc123')
    expect(chunks[0]!.textContent).toContain('automatic')
    expect(chunks[0]!.textContent).toContain('finished variant filtering')
    expect(chunks[1]!.textContent).toContain('level 2')
    expect(chunks[1]!.textContent).toContain('manual')
  })

  it('expands a chunk to show the summary and transcript preview', async () => {
    getChunks.mockResolvedValue([makeChunk({})])
    renderPanel()
    await act(async () => {})

    const toggle = container.querySelector('[data-testid="fold-chunk-toggle"]')
    expect(container.querySelector('[data-testid="fold-chunk-body"]')).toBeNull()
    act(() => {
      ;(toggle as HTMLButtonElement).click()
    })
    const body = container.querySelector('[data-testid="fold-chunk-body"]')
    expect(body).not.toBeNull()
    expect(body!.textContent).toContain('Context was compacted')
    expect(body!.textContent).toContain('Filter EGFR variants')
  })
})
