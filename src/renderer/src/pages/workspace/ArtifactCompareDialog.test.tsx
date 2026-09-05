// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactVersionDescriptor } from '../../../../shared/artifact-provenance'

import { ArtifactCompareDialog } from './ArtifactCompareDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
}
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {
      /* no-op */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
}

const readPreview = vi.hoisted(() => vi.fn())

const contentByVersion: Record<string, string> = {
  'version-1': 'alpha\nbeta\ngamma\n',
  'version-2': 'alpha\nbeta\ngamma\ndelta\n',
  'version-3': 'alpha\nbeta\nepsilon\ndelta\n'
}
const DEFAULT_VERSION_CONTENT = { ...contentByVersion }

beforeEach(() => {
  Object.assign(contentByVersion, DEFAULT_VERSION_CONTENT)
  readPreview.mockReset()
  readPreview.mockImplementation(async (request: { path: string }) => {
    const versionId = Object.keys(contentByVersion).find((candidate) =>
      request.path.includes(candidate)
    )
    const content = versionId ? contentByVersion[versionId] : ''
    return {
      content,
      encoding: 'utf8',
      size: content.length,
      truncated: false,
      offset: 0
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      artifacts: {
        readPreview
      }
    }
  })
})

const versions: ArtifactVersionDescriptor[] = [
  {
    id: 'version-1',
    versionId: 'version-1',
    artifactId: 'artifact-1',
    versionNumber: 1,
    checksum: 'checksum-1',
    createdAt: '2026-09-01T10:00:00.000Z',
    state: 'finalized',
    projectName: 'project-1',
    sessionId: 'session-1',
    runId: 'artifact-run-1',
    name: 'notes.md',
    size: 17,
    mtimeMs: 1000
  },
  {
    id: 'version-2',
    versionId: 'version-2',
    artifactId: 'artifact-1',
    versionNumber: 2,
    checksum: 'checksum-2',
    createdAt: '2026-09-02T10:00:00.000Z',
    state: 'finalized',
    projectName: 'project-1',
    sessionId: 'session-1',
    runId: 'artifact-run-1',
    name: 'notes.md',
    size: 23,
    mtimeMs: 2000
  },
  {
    id: 'version-3',
    versionId: 'version-3',
    artifactId: 'artifact-1',
    versionNumber: 3,
    checksum: 'checksum-3',
    createdAt: '2026-09-03T10:00:00.000Z',
    state: 'finalized',
    projectName: 'project-1',
    sessionId: 'session-1',
    runId: 'artifact-run-1',
    name: 'notes.md',
    size: 27,
    mtimeMs: 3000
  }
]

let container: HTMLDivElement
let root: Root

const renderDialog = async ({
  open = true,
  initialBaseVersionId,
  initialTargetVersionId
}: {
  open?: boolean
  initialBaseVersionId?: string
  initialTargetVersionId?: string
} = {}): Promise<void> => {
  await act(async () => {
    root.render(
      <ArtifactCompareDialog
        open={open}
        name="notes.md"
        projectId="project-1"
        sessionId="session-1"
        artifactId="artifact-1"
        versions={versions}
        initialBaseVersionId={initialBaseVersionId}
        initialTargetVersionId={initialTargetVersionId}
        onClose={vi.fn()}
      />
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const findButton = (label: string): HTMLButtonElement | undefined => {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === label
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ArtifactCompareDialog', () => {
  it('defaults to the selected version against its predecessor and renders the line diff', async () => {
    await renderDialog({ initialTargetVersionId: 'version-2' })

    const diff = document.body.querySelector('[data-testid="compare-diff"]')
    expect(diff).not.toBeNull()
    const rows = [...document.body.querySelectorAll('[data-testid="compare-diff"] [data-kind]')]
    const added = rows.filter((row) => row.getAttribute('data-kind') === 'added')
    expect(added.map((row) => row.textContent?.trim().endsWith('delta'))).toEqual([true])
    // Both locators were requested for the default pair v1 -> v2.
    const requestedPaths = readPreview.mock.calls.map((call) => call[0].path)
    expect(requestedPaths.some((path) => path.includes('version-1'))).toBe(true)
    expect(requestedPaths.some((path) => path.includes('version-2'))).toBe(true)
    expect(document.body.querySelector('[data-testid="compare-additions"]')?.textContent).toContain(
      '1'
    )
    expect(document.body.querySelector('[data-testid="compare-deletions"]')?.textContent).toContain(
      '0'
    )
  })

  it('swaps base and target versions and recomputes the diff', async () => {
    await renderDialog({ initialTargetVersionId: 'version-2' })
    await act(async () => {
      findButton('Swap base and compared version')?.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // After the swap the delta line is removed from the target (v1) side.
    const diff = document.body.querySelector('[data-testid="compare-diff"]')
    const rows = [...(diff?.querySelectorAll('[data-kind]') ?? [])]
    const removed = rows.filter((row) => row.getAttribute('data-kind') === 'removed')
    expect(removed.map((row) => row.textContent?.trim().endsWith('delta'))).toEqual([true])
  })

  it('shows the no-changes state for identical contents', async () => {
    contentByVersion['version-3'] = contentByVersion['version-2']
    await renderDialog({ initialTargetVersionId: 'version-3' })

    expect(document.body.querySelector('[data-testid="compare-no-changes"]')).not.toBeNull()
    expect(document.body.textContent).toContain('No differences between these versions')
  })

  it('falls back to the last pair when the requested target is the first version', async () => {
    await renderDialog({ initialTargetVersionId: 'version-1' })

    // v1 has no predecessor, so the dialog falls back to the last pair (v2 -> v3) instead of
    // comparing a Version with itself.
    const diff = document.body.querySelector('[data-testid="compare-diff"]')
    expect(diff).not.toBeNull()
    const requestedPaths = readPreview.mock.calls.map((call) => call[0].path)
    expect(requestedPaths.some((path) => path.includes('version-2'))).toBe(true)
    expect(requestedPaths.some((path) => path.includes('version-3'))).toBe(true)
  })

  it('shows a load-failure state when a version cannot be read', async () => {
    readPreview.mockRejectedValueOnce(new Error('read failed'))
    await renderDialog({ initialTargetVersionId: 'version-2' })

    expect(document.body.textContent).toContain(
      'Could not load the version contents for comparison.'
    )
  })

  it('shows the too-large message for oversized versions', async () => {
    readPreview.mockResolvedValue({
      content: '',
      encoding: 'utf8',
      size: 30 * 1024 * 1024,
      truncated: false,
      offset: 0
    })
    await renderDialog({ initialTargetVersionId: 'version-2' })

    expect(document.body.textContent).toContain('A version is too large to compare in the preview.')
  })
})
