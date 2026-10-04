// @vitest-environment jsdom
// The open/reveal cluster beside a managed artifact preview. The window is given two real controls; this
// pins the half a real run cannot reach — a handler that REFUSES. Both handoffs now go through the
// artifact surface (`artifacts:open-file` / `artifacts:reveal-file`), which resolves the preview handle
// (a Version locator, not a filesystem path) before the OS sees it, and refuses by name when the path is
// outside artifact storage (`storage-access.ts:100`). A refusal that went nowhere would leave the reader
// clicking a button that looks inert, which is the defect this control exists to close.
//
// The regression this file also guards: reveal must NOT be wired to the raw local-fs channel. The preview
// handle is `artifact-version:<project>/<session>/<artifact>/<version>`; handed straight to `local-fs:reveal`
// it is refused with "Local path must be absolute." on every machine, which is exactly what the packaged
// macos runner caught. `localFsReveal` is spied and asserted unused so that wiring cannot come back.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let container: HTMLDivElement
let root: Root

const REFUSAL = 'Artifact file is outside artifact storage.'

const installBridge = (
  openFile: (request: { path: string }) => Promise<void>,
  revealFile: (request: { path: string }) => Promise<void>
): {
  openFile: ReturnType<typeof vi.fn>
  revealFile: ReturnType<typeof vi.fn>
  localFsReveal: ReturnType<typeof vi.fn>
} => {
  const openSpy = vi.fn(openFile)
  const revealSpy = vi.fn(revealFile)
  const localFsRevealSpy = vi.fn(() => Promise.resolve())
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    artifacts: { openFile: openSpy, revealFile: revealSpy },
    localFs: { reveal: localFsRevealSpy }
  }
  return { openFile: openSpy, revealFile: revealSpy, localFsReveal: localFsRevealSpy }
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
  it('hands the preview handle to both artifact handoffs, never to the raw local-fs reveal', async () => {
    const bridge = installBridge(
      () => Promise.resolve(),
      () => Promise.resolve()
    )
    const locator = 'artifact-version:proj/sess/art/ver'
    await render(locator)

    await click('artifact-open-with-system')
    await click('artifact-show-in-folder')

    // Both actions ask the artifact surface, which resolves the locator before the OS sees a path.
    expect(bridge.openFile).toHaveBeenCalledWith({ path: locator })
    expect(bridge.revealFile).toHaveBeenCalledWith({ path: locator })
    // The raw local-fs channel only accepts absolute filesystem paths; a locator there is refused on every
    // machine, so this cluster must never reach it.
    expect(bridge.localFsReveal).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="artifact-open-failure"]')).toBeNull()
  })

  it('shows the handler’s own refusal instead of swallowing it, and clears it on a later success', async () => {
    installBridge(
      () => Promise.reject(new Error(REFUSAL)),
      () => Promise.reject(new Error(REFUSAL))
    )
    await render('outside/table-evidence.pdf')

    await click('artifact-show-in-folder')
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
