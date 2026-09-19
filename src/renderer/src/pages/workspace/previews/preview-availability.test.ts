// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  requestPreviewAvailability,
  resetPreviewAvailabilityForTests
} from './preview-availability'

// The point of the batch is that N cards asking in the same tick cost one call, and that no card's answer
// depends on another card's read (the failure the per-card limiter had). These pin both.
const installBridge = (
  probe: (request: { items: Array<{ path: string }> }) => Promise<{ unavailable: string[] }>
): ReturnType<typeof vi.fn> => {
  const spy = vi.fn(probe)
  ;(window as unknown as { api: unknown }).api = { artifacts: { probeAvailability: spy } }
  return spy
}

const flushTicks = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  resetPreviewAvailabilityForTests()
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('requestPreviewAvailability', () => {
  it('asks once for every card that requested in the same tick and answers each path', async () => {
    const probe = installBridge(async ({ items }) => ({
      unavailable: items.filter((item) => item.path.includes('gone')).map((item) => item.path)
    }))

    const answers = await Promise.all([
      requestPreviewAvailability({ path: '/a/one.png', source: 'artifact', projectId: 'p1' }),
      requestPreviewAvailability({ path: '/a/gone.png', source: 'artifact', projectId: 'p1' }),
      requestPreviewAvailability({ path: '/a/two.png', source: 'upload', projectId: 'p1' })
    ])

    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0]?.[0].items).toHaveLength(3)
    expect(answers).toEqual([false, true, false])
  })

  it('serves a repeat of the same path from the batch cache', async () => {
    const probe = installBridge(async () => ({ unavailable: ['/a/gone.png'] }))

    await expect(
      requestPreviewAvailability({ path: '/a/gone.png', source: 'artifact', projectId: 'p1' })
    ).resolves.toBe(true)
    await flushTicks()
    await expect(
      requestPreviewAvailability({ path: '/a/gone.png', source: 'artifact', projectId: 'p1' })
    ).resolves.toBe(true)

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('answers available and stays retryable when the batch call fails', async () => {
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error('main is unavailable'))
      .mockResolvedValueOnce({ unavailable: ['/a/one.png'] })
    ;(window as unknown as { api: unknown }).api = { artifacts: { probeAvailability: failing } }

    await expect(
      requestPreviewAvailability({ path: '/a/one.png', source: 'artifact', projectId: 'p1' })
    ).resolves.toBe(false)
    await flushTicks()
    // Not cached as available by the failure, so the next mount asks again and gets the real answer.
    await expect(
      requestPreviewAvailability({ path: '/a/one.png', source: 'artifact', projectId: 'p1' })
    ).resolves.toBe(true)
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it('resolves without a batched bridge instead of leaving the cards waiting', async () => {
    await expect(
      requestPreviewAvailability({ path: '/a/one.png', source: 'artifact', projectId: 'p1' })
    ).resolves.toBe(false)
  })
})
