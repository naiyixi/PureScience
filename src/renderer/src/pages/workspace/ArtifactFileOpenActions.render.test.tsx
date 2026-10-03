// @vitest-environment jsdom
// The open/reveal cluster beside a managed artifact preview. The window is given two real controls; this
// pins the half a real run cannot reach — a handler that REFUSES. `artifacts:open-file` refuses by name
// (a path outside artifact storage, an unconfigured provenance resolver), and a refusal that went nowhere
// would leave the reader clicking a button that looks inert, which is the defect this control exists to
// close. The message asserted below is the one the real handler produces (`storage-access.ts:100`).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let container: HTMLDivElement
let root: Root

const REFUSAL = 'Artifact file is outside artifact storage.'

const installBridge = (
  openFile: (request: { path: string }) => Promise<void>,
  reveal: (path: string) => Promise<void>
): { openFile: ReturnType<typeof vi.fn>; reveal: ReturnType<typeof vi.fn> } => {
  const openSpy = vi.fn(openFile)
  const revealSpy = vi.fn(reveal)
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    artifacts: { openFile: openSpy },
    localFs: { reveal: revealSpy }
  }
  return { openFile: openSpy, reveal: revealSpy }
}

const render = async (path: string): Promise<void> => {
  const { ArtifactFileOpenActions } = await import('./ArtifactFileOpenActions')
  act(() => {
    root.render(<ArtifactFileOpenActions path={path} />)
  })
}

const click = async (testId: string): Promise<void> => {
  const button = container.querySelector(`[data-testid="${testId}"]`)
  expect(button, `${testId} is not rendered`).not.toBeNull()
  await act(async () => {
    ;(button as HTMLButtonElement).click()
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
})

describe('ArtifactFileOpenActions', () => {
  it('hands the preview item’s own path to the opener and to the file manager', async () => {
    const bridge = installBridge(
      () => Promise.resolve(),
      () => Promise.resolve()
    )
    await render('v1/table-evidence.pdf')

    await click('artifact-open-with-system')
    await click('artifact-show-in-folder')

    expect(bridge.openFile).toHaveBeenCalledWith({ path: 'v1/table-evidence.pdf' })
    expect(bridge.reveal).toHaveBeenCalledWith('v1/table-evidence.pdf')
    expect(container.querySelector('[data-testid="artifact-open-failure"]')).toBeNull()
  })

  it('shows the handler’s own refusal instead of swallowing it, and clears it on a later success', async () => {
    installBridge(
      () => Promise.reject(new Error(REFUSAL)),
      () => Promise.resolve()
    )
    await render('outside/table-evidence.pdf')

    await click('artifact-open-with-system')
    const badge = container.querySelector('[data-testid="artifact-open-failure"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent ?? '').toContain(REFUSAL)

    // A refusal must not outlive the file it was about: the next attempt that succeeds takes it off screen.
    installBridge(
      () => Promise.resolve(),
      () => Promise.resolve()
    )
    await click('artifact-open-with-system')
    expect(container.querySelector('[data-testid="artifact-open-failure"]')).toBeNull()
  })
})
