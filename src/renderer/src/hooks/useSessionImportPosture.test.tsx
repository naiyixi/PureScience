// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SESSION_PACKAGE_IMPORT_POSTURE,
  type SessionPackageImportRecord
} from '../../../shared/session-package-import'
import { useSessionImportPosture, type SessionImportPosture } from './useSessionImportPosture'

// Type-only mirror of what a caller holds; the point of the unit is that only these two fields matter.
type SessionIdentity = { id: string; projectId: string }

const recordFor = (sourceSessionId: string): SessionPackageImportRecord => ({
  importedAt: '2026-11-10T00:00:00.000Z',
  importedFrom: {
    sessionId: sourceSessionId,
    projectId: 'source-project',
    appVersion: '2.26.0',
    exportedAt: '2026-11-09T00:00:00.000Z'
  },
  posture: SESSION_PACKAGE_IMPORT_POSTURE,
  assertion: { origin: 'source-party', locallyVerified: false },
  notes: []
})

const deferred = (): {
  promise: Promise<SessionPackageImportRecord | null>
  resolve: (record: SessionPackageImportRecord | null) => void
} => {
  let resolve!: (record: SessionPackageImportRecord | null) => void
  const promise = new Promise<SessionPackageImportRecord | null>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('useSessionImportPosture', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: SessionImportPosture | null
  const importPosture =
    vi.fn<(request: { projectId: string; sessionId: string }) => Promise<unknown>>()

  const Harness = ({ session }: { session: SessionIdentity | undefined }): null => {
    latest = useSessionImportPosture(session?.projectId, session?.id)
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    latest = null
    importPosture.mockReset()
    importPosture.mockResolvedValue(null)
    window.api = { sessions: { importPosture } } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  // The regression this pins: the caller re-derives the session object from the store on every stream
  // chunk, so an object-keyed read issued one main-process call per chunk. Same id, same record ⇒ one read.
  it('reads once per opened session even when the caller hands over a fresh object each render', async () => {
    const first: SessionIdentity = { id: 'session-a', projectId: 'project-1' }
    await act(async () => root.render(<Harness session={first} />))
    await act(async () => {
      await Promise.resolve()
    })
    expect(importPosture).toHaveBeenCalledTimes(1)
    expect(importPosture).toHaveBeenCalledWith({ projectId: 'project-1', sessionId: 'session-a' })

    await act(async () => root.render(<Harness session={{ ...first }} />))
    await act(async () => root.render(<Harness session={{ ...first }} />))
    await act(async () => {
      await Promise.resolve()
    })
    expect(importPosture).toHaveBeenCalledTimes(1)
  })

  it('surfaces the record under the session it belongs to, and reads again when the session changes', async () => {
    const a = deferred()
    const b = deferred()
    importPosture
      .mockImplementationOnce(() => a.promise as Promise<unknown>)
      .mockImplementationOnce(() => b.promise as Promise<unknown>)

    await act(async () =>
      root.render(<Harness session={{ id: 'session-a', projectId: 'project-1' }} />)
    )
    await act(async () => a.resolve(recordFor('source-a')))
    expect(latest?.sessionId).toBe('session-a')
    expect(latest?.record.importedFrom.sessionId).toBe('source-a')

    await act(async () =>
      root.render(<Harness session={{ id: 'session-b', projectId: 'project-1' }} />)
    )
    // The answer for A must not show up under B while B is still being read.
    expect(latest).toBeNull()
    await act(async () => b.resolve(recordFor('source-b')))
    expect(latest?.sessionId).toBe('session-b')
    expect(latest?.record.importedFrom.sessionId).toBe('source-b')
    expect(importPosture).toHaveBeenCalledTimes(2)
  })

  it('drops an answer that arrives after the session already changed', async () => {
    const a = deferred()
    importPosture.mockImplementationOnce(() => a.promise as Promise<unknown>)

    await act(async () =>
      root.render(<Harness session={{ id: 'session-a', projectId: 'project-1' }} />)
    )
    await act(async () =>
      root.render(<Harness session={{ id: 'session-b', projectId: 'project-1' }} />)
    )
    await act(async () => a.resolve(recordFor('source-a')))

    expect(latest).toBeNull()
  })

  it('stays silent for an ordinary session, and in the Web renderer where the bridge is absent', async () => {
    await act(async () =>
      root.render(<Harness session={{ id: 'session-a', projectId: 'project-1' }} />)
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(latest).toBeNull()
    expect(importPosture).toHaveBeenCalledTimes(1)

    window.api = { sessions: {} } as unknown as Window['api']
    importPosture.mockClear()
    await act(async () =>
      root.render(<Harness session={{ id: 'session-b', projectId: 'project-1' }} />)
    )
    expect(latest).toBeNull()
    expect(importPosture).not.toHaveBeenCalled()
  })
})
