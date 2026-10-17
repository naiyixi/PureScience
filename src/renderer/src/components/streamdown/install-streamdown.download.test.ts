// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installStreamdown } from './install-streamdown'

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

let uninstall: (() => void) | undefined
let saveBlobFile: ReturnType<typeof vi.fn>

const clickBlobDownload = (url: string, filename = 'result.csv'): void => {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.addEventListener('click', (event) => event.preventDefault())
  document.body.appendChild(anchor)
  anchor.click()
}

beforeEach(() => {
  saveBlobFile = vi.fn().mockResolvedValue({ saved: true })
  ;(window as unknown as { api: unknown }).api = { saveBlobFile }
  uninstall = installStreamdown()
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Streamdown blob download bridge', () => {
  it('saves a blob created synchronously by the current Streamdown button action', async () => {
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    const button = document.createElement('button')
    button.addEventListener('click', () => {
      clickBlobDownload(URL.createObjectURL(new Blob(['a,b'], { type: 'text/csv' })))
    })
    root.appendChild(button)
    document.body.appendChild(root)

    button.click()
    await vi.waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce(), {
      timeout: COORDINATION_WINDOW_MS
    })
  })

  it('does not claim an unrelated blob download after another Streamdown button click', async () => {
    const unrelatedUrl = URL.createObjectURL(new Blob(['pdf'], { type: 'application/pdf' }))
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    const button = document.createElement('button')
    root.appendChild(button)
    document.body.appendChild(root)

    button.click()
    clickBlobDownload(unrelatedUrl)
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(saveBlobFile).not.toHaveBeenCalled()
  })

  it('saves an image blob created asynchronously by the Streamdown image download action', async () => {
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    const imageWrapper = document.createElement('div')
    imageWrapper.dataset.streamdown = 'image-wrapper'
    const button = document.createElement('button')
    imageWrapper.appendChild(button)
    root.appendChild(imageWrapper)
    document.body.appendChild(root)

    button.click()
    await Promise.resolve()
    clickBlobDownload(URL.createObjectURL(new Blob(['png'], { type: 'image/png' })), 'image.png')

    await vi.waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce(), {
      timeout: COORDINATION_WINDOW_MS
    })
  })
})
