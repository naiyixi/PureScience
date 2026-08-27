import { describe, expect, it, vi } from 'vitest'

import { withCorrelatedFetch } from './request-correlation'

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}))

type CallArgs = [unknown, { headers?: Record<string, string> } | undefined]

const firstCall = (fn: ReturnType<typeof vi.fn>): CallArgs =>
  fn.mock.calls[0] as unknown as CallArgs

describe('withCorrelatedFetch', () => {
  it('adds an x-request-id header to every request', async () => {
    const inner = vi.fn(async (_url: unknown, _init?: unknown) => ({ status: 200 }))
    const wrapped = withCorrelatedFetch(inner)

    await wrapped('https://example.com/data', { headers: { Accept: 'application/json' } })

    const [url, init] = firstCall(inner)
    expect(url).toBe('https://example.com/data')
    expect(init?.headers?.['x-request-id']).toMatch(/^req-[a-f0-9]{8}$/)
    expect(init?.headers?.['Accept']).toBe('application/json')
  })

  it('generates a fresh id per request', async () => {
    const inner = vi.fn(async (_url: unknown, _init?: unknown) => ({ status: 200 }))
    const wrapped = withCorrelatedFetch(inner)

    await wrapped('https://example.com/a')
    await wrapped('https://example.com/b')

    const first = firstCall(inner)[1]?.headers?.['x-request-id']
    const second = (inner.mock.calls[1] as unknown as CallArgs)[1]?.headers?.['x-request-id']
    expect(first).not.toBe(second)
  })

  it('propagates request errors after logging them', async () => {
    const inner = vi.fn(async (_url: unknown, _init?: unknown) => {
      throw new Error('boom')
    })
    const wrapped = withCorrelatedFetch(inner)

    await expect(wrapped('https://example.com/err')).rejects.toThrow('boom')
  })
})
