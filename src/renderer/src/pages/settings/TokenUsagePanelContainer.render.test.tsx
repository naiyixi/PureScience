// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SESSION_MANIFEST_VERSION,
  type PersistedChatSession
} from '../../../../shared/session-persistence'
import { TokenUsagePanelContainer } from './TokenUsagePanelContainer'

let container: HTMLDivElement
let root: Root
let loadAll: ReturnType<typeof vi.fn>

const deferred = (): {
  promise: Promise<{ sessions: PersistedChatSession[]; manifest: { version: number } }>
  resolve: (value: { sessions: PersistedChatSession[]; manifest: { version: number } }) => void
} => {
  let resolve!: (value: { sessions: PersistedChatSession[]; manifest: { version: number } }) => void
  const promise = new Promise<{ sessions: PersistedChatSession[]; manifest: { version: number } }>(
    (res) => {
      resolve = res
    }
  )
  return { promise, resolve }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  loadAll = vi.fn()
  window.api = {
    sessions: {
      loadAll,
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      saveManifest: vi.fn()
    }
  } as unknown as typeof window.api
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('the token usage container', () => {
  it('fetches the full catalog instead of aggregating from the store, and waits for it', async () => {
    // This view reads every session's conversation graph and each message's turnUsage, none of which the list
    // tier carries. Reading summaries would silently report a total of zero, so the container must ask for the
    // full catalog — and must not render the panel until that read lands.
    const pending = deferred()
    loadAll.mockReturnValueOnce(pending.promise)

    await act(async () => root.render(<TokenUsagePanelContainer projects={[]} />))

    expect(loadAll).toHaveBeenCalledTimes(1)
    // Nothing that could be mistaken for a total is on screen while the read is in flight.
    expect(container.textContent).toContain('Loading')

    await act(async () => {
      pending.resolve({
        sessions: [],
        manifest: { version: SESSION_MANIFEST_VERSION }
      })
      await pending.promise
    })

    expect(container.textContent).not.toContain('Loading')
  })

  it('keeps the loading state when the read fails, rather than claiming no usage', async () => {
    loadAll.mockRejectedValueOnce(new Error('EACCES'))

    await act(async () => root.render(<TokenUsagePanelContainer projects={[]} />))
    await act(async () => {
      await Promise.resolve()
    })

    // A failed read is not "zero tokens": it stays in the loading state so the panel never states a number it
    // does not have.
    expect(container.textContent).toContain('Loading')
  })
})
