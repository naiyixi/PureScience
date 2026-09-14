import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMainHandle = vi.fn()

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (...args: unknown[]) => ipcMainHandle(...args)
}))

import { createSearchIpcHandlers, registerSearchIpcHandlers } from './ipc'

const ports = (): Parameters<typeof createSearchIpcHandlers>[0] => ({
  loadSessions: async () => [],
  listFiles: async () => [],
  listReferences: async () => []
})

beforeEach(() => {
  ipcMainHandle.mockClear()
})

describe('search IPC surface', () => {
  it('registers the query channel on the desktop surface', () => {
    registerSearchIpcHandlers(createSearchIpcHandlers(ports()))

    expect(ipcMainHandle).toHaveBeenCalledTimes(1)
    expect(ipcMainHandle.mock.calls[0][0]).toBe('search:query')
  })

  it('routes an invocation to the handler with the caller request', async () => {
    const handlers = createSearchIpcHandlers(ports())
    registerSearchIpcHandlers(handlers)
    const invoked = ipcMainHandle.mock.calls[0][1] as (
      event: unknown,
      request: { query: string }
    ) => Promise<unknown>

    const response = (await invoked({}, { query: 'sin' })) as { query: string; hits: unknown[] }

    expect(response.query).toBe('sin')
    expect(response.hits).toEqual([])
  })
})
