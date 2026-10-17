// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { connectOfficePreviewRuntime } from './office-preview-controller'
import { OfficePreviewRuntimeError, type RunOfficePreviewOptions } from './office-preview-runtime'

/**
 * How long a coordination wait may take.
 *
 * Every `vi.waitFor` in this file is a *coordination* wait: it waits for the side effect of work that
 * is already in flight (a spy being called, a process dying, a worker reporting that it started, a
 * rendered node reaching its final text), never for something that may never happen. The only thing
 * the window has to cover is how long a loaded machine takes to schedule that continuation -- so the
 * default 1s is a quiet-machine budget, not a correctness budget. Measured on this repository: under
 * load a coordinated wait took up to 704ms (34 samples, p90 = 361ms), and a site elsewhere in the
 * suite failed at ~1.1s under load average ~70 while passing on a quiet machine.
 *
 * 30s matches the window this repository already uses for load-sensitive waits, and it stays well below
 * vitest's 60s per-test timeout, so an assertion that is genuinely stuck still fails as a failure
 * instead of hanging.
 */
const COORDINATION_WINDOW_MS = 30_000

describe('connectOfficePreviewRuntime', () => {
  it('runs the received session and disposes it with the runtime subscription', async () => {
    let startListener: ((start: never) => void) | undefined
    const removeStartListener = vi.fn()
    const reportState = vi.fn()
    const disposeRender = vi.fn()
    const runPreview = vi.fn().mockResolvedValue(disposeRender)
    const container = document.createElement('div')
    const bridge = {
      onStart: vi.fn((listener) => {
        startListener = listener
        return removeStartListener
      }),
      reportState
    }
    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'purescience-preview://resource-1/report.pptx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'pptx' as const,
      name: 'report.pptx',
      attempt: 0
    }

    const disconnect = connectOfficePreviewRuntime({ bridge, container, runPreview })
    startListener?.(start as never)
    await Promise.resolve()
    await Promise.resolve()

    expect(runPreview).toHaveBeenCalledWith({
      start,
      container,
      fetchFile: fetch,
      reportState: expect.any(Function)
    })

    await disconnect()
    expect(removeStartListener).toHaveBeenCalledOnce()
    expect(disposeRender).toHaveBeenCalledOnce()
  })

  it('reports the stable error code returned by the isolated runtime', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let startListener: ((start: never) => void) | undefined
    const reportState = vi.fn()
    const bridge = {
      onStart: vi.fn((listener) => {
        startListener = listener
        return vi.fn()
      }),
      reportState
    }
    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'purescience-preview://resource-1/report.docx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'docx' as const,
      name: 'report.docx',
      attempt: 0
    }
    const runPreview = vi
      .fn()
      .mockRejectedValue(new OfficePreviewRuntimeError('INVALID_PACKAGE', 'Invalid package'))

    connectOfficePreviewRuntime({
      bridge,
      container: document.createElement('div'),
      runPreview
    })
    startListener?.(start as never)
    await vi.waitFor(
      () => {
        expect(reportState).toHaveBeenCalledWith({
          sessionId: 'session-1',
          phase: 'error',
          error: 'INVALID_PACKAGE'
        })
      },
      { timeout: COORDINATION_WINDOW_MS }
    )
  })

  it('keeps rendered content hidden until the runtime reports ready', async () => {
    let startListener: ((start: never) => void) | undefined
    const container = document.createElement('div')
    const reportState = vi.fn((state: { phase: string }) => {
      if (state.phase === 'ready') {
        expect(container.dataset.officePreviewReady).toBe('true')
      }
    })
    const bridge = {
      onStart: vi.fn((listener) => {
        startListener = listener
        return vi.fn()
      }),
      reportState
    }
    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'purescience-preview://resource-1/report.pptx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'pptx' as const,
      name: 'report.pptx',
      attempt: 0
    }
    const runPreview = vi.fn(async (options: RunOfficePreviewOptions) => {
      expect(container.dataset.officePreviewReady).toBe('false')
      options.reportState({
        sessionId: start.sessionId,
        phase: 'rendering',
        title: 'Rendering the preview'
      })
      expect(container.dataset.officePreviewReady).toBe('false')
      options.reportState({ sessionId: start.sessionId, phase: 'ready' })
      return vi.fn()
    })

    connectOfficePreviewRuntime({ bridge, container, runPreview })
    startListener?.(start as never)

    await vi.waitFor(() => expect(reportState).toHaveBeenCalledTimes(2), {
      timeout: COORDINATION_WINDOW_MS
    })
  })
})
