import { describe, expect, it } from 'vitest'

import { createIpcChannelLatency, IPC_CHANNEL_LATENCY_CAPACITY } from './ipc-channel-latency'

// The accumulator that makes "is this channel fast now" answerable at all: the slow-operation ring only has
// the calls that crossed 50 ms, so before this every reading of a channel's ordinary cost was absent, and an
// empty list read as "fast". These cases pin the three properties a reader depends on: the empty state names
// itself, the quantiles are exact over a window whose size is stated, and the list points at the worst tail
// without hiding that it truncated.

describe('createIpcChannelLatency', () => {
  it('names the empty state instead of shipping an empty list that reads like a fast app', () => {
    const latency = createIpcChannelLatency()

    expect(latency.summary()).toEqual({
      capacity: IPC_CHANNEL_LATENCY_CAPACITY,
      channelsObserved: 0,
      untrackedCalls: 0,
      status: 'no-calls-observed',
      channels: [],
      omitted: 0
    })
  })

  it('reports exact nearest-rank quantiles over the samples it was given', () => {
    const latency = createIpcChannelLatency({ capacity: 8 })

    // Ten samples with capacity 8 so both sides are hand-checkable: the window keeps the *last* eight
    // (8..1 ⇒ sorted 1..8), so nearest-rank p50 = 4 (`ceil(0.5×8)-1 = 3`) and p95 = 8, while the peak of the
    // whole history (10) is still reported separately because it has already rolled out of the window.
    for (const durationMs of [10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
      latency.record('settings:get-settings', durationMs)
    const [entry] = latency.summary().channels

    expect(entry).toEqual({
      channel: 'settings:get-settings',
      observed: 10,
      windowSamples: 8,
      p50Ms: 4,
      p95Ms: 8,
      windowMaxMs: 8,
      maxMs: 10,
      rejectedInWindow: 0
    })
  })

  it('keeps `observed` counting after the window rolls, and the quantiles describe only the window', () => {
    const latency = createIpcChannelLatency({ capacity: 4 })

    // Four slow calls, then four fast ones: the window must forget the slow ones, the counter must not.
    for (const durationMs of [400, 400, 400, 400])
      latency.record('sessions:save-session', durationMs)
    for (const durationMs of [4, 5, 6, 7]) latency.record('sessions:save-session', durationMs)
    const [entry] = latency.summary().channels

    expect(entry).toMatchObject({
      observed: 8,
      windowSamples: 4,
      // Sorted window 4,5,6,7 ⇒ nearest-rank p50 = 5 (`ceil(0.5×4)-1 = 1`), p95 = 7.
      p50Ms: 5,
      p95Ms: 7,
      windowMaxMs: 7,
      // The peak is remembered even though it left the window: "it used to be 400 ms" must not disappear.
      maxMs: 400
    })
  })

  it('counts rejections, because a channel that fails fast can look like a fast channel', () => {
    const latency = createIpcChannelLatency({ capacity: 4 })

    latency.record('storage:get-info', 2, { rejected: true })
    latency.record('storage:get-info', 3, { rejected: true })
    latency.record('storage:get-info', 40)
    const [entry] = latency.summary().channels

    expect(entry).toMatchObject({ windowSamples: 3, p50Ms: 3, rejectedInWindow: 2 })
  })

  it('lists the worst tail first and says how many channels it left out', () => {
    const latency = createIpcChannelLatency({ capacity: 4, limit: 2 })

    latency.record('fast', 1)
    latency.record('middle', 20)
    latency.record('slow', 300)
    const summary = latency.summary()

    expect(summary.channels.map((entry) => entry.channel)).toEqual(['slow', 'middle'])
    expect(summary.channelsObserved).toBe(3)
    expect(summary.omitted).toBe(1)
  })

  it('counts calls it cannot track instead of dropping them silently', () => {
    const latency = createIpcChannelLatency({ maxChannels: 2 })

    latency.record('a', 5)
    latency.record('b', 5)
    latency.record('c', 5)
    const summary = latency.summary()

    expect(summary.channelsObserved).toBe(2)
    expect(summary.untrackedCalls).toBe(1)
  })

  it('ignores values that are not a measurement rather than counting them as zero', () => {
    const latency = createIpcChannelLatency({ capacity: 4 })

    latency.record('notebook:state', Number.NaN)
    latency.record('notebook:state', -1)
    latency.record('', 5)

    expect(latency.summary().status).toBe('no-calls-observed')
  })

  it('forgets everything on clear, including the peak and the untracked count', () => {
    const latency = createIpcChannelLatency({ capacity: 2, maxChannels: 1 })

    latency.record('a', 100)
    latency.record('b', 100)
    latency.clear()

    expect(latency.summary()).toMatchObject({
      status: 'no-calls-observed',
      channelsObserved: 0,
      untrackedCalls: 0
    })
  })
})
