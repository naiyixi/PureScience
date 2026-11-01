// What the slow-operation ring cannot answer, and why this exists: that ring only carries the calls that
// crossed a threshold (50 ms for IPC). Every question of the form "is this channel fast *now*" therefore has
// no reading — the only durable evidence is the slow tail, so a channel that went from 20 ms to 70 ms across
// a release looks exactly like one that never changed, and a target written as "median under 80 ms" cannot be
// checked at all. Measured, not assumed: the ring's own summary says `no-slow-operations-observed` both when a
// process was fast and when nobody was watching, and nothing in the product recorded the calls below 50 ms.
//
// This is the missing half: every completion of an IPC call, per channel, kept as an exact duration window.
// It is deliberately *not* a second opinion about slowness — it does not threshold, log or classify anything.
// It answers one question ("what did the last N calls of this channel cost") and leaves the verdict to the
// reader, so it cannot disagree with the slow-call lines about what "slow" means.
//
// The window is exact and explicitly bounded: the retained samples are the most recent `capacity`
// completions (a ring of typed arrays, no per-call allocation), and the quantiles are computed over exactly
// those samples by nearest rank when a summary is taken. Two consequences are written into the shape rather
// than into a comment a reader might miss: `observed` counts every completion since the process started
// (so `observed > windowSamples` says the window has rolled), and the summary's `status` names the case where
// nothing was recorded at all instead of shipping an empty list that reads like a fast application.
//
// Process-wide singleton for the same reason as `slow-operation-ring`: the producer is created where the IPC
// adapter module loads and the bundle facts are assembled in the composition root, so a hand-off would add a
// seam neither side needs. Tests inject their own instance.

/** How many completions per channel the window keeps. Small enough that hundreds of channels stay cheap. */
export const IPC_CHANNEL_LATENCY_CAPACITY = 128

/**
 * How many distinct channels may be tracked. The renderer-visible surface is a few hundred channels, so this
 * is headroom rather than a limit anyone should hit; when it is hit, the calls are counted in `untrackedCalls`
 * instead of silently vanishing (an unbounded diagnostic is a leak, a silently dropped one is a false reading).
 */
export const IPC_CHANNEL_LATENCY_MAX_CHANNELS = 512

/** The channels the summary lists, worst tail first. The rest are counted in `omitted`. */
export const IPC_CHANNEL_LATENCY_SUMMARY_LIMIT = 32

export type IpcChannelLatencySummaryEntry = {
  /** IPC channel name — the identifier a maintainer greps for. */
  channel: string
  /** Completions of this channel since the process started (kept + rolled out of the window). */
  observed: number
  /** How many completions the quantiles below are computed over: the last `min(observed, capacity)`. */
  windowSamples: number
  /** Nearest-rank median of the window, in milliseconds. */
  p50Ms: number
  /** Nearest-rank 95th percentile of the window, in milliseconds. */
  p95Ms: number
  /** Largest completion in the window. */
  windowMaxMs: number
  /** Largest completion since the process started, even if it has rolled out of the window. */
  maxMs: number
  /** How many of the window's completions ended in a rejection (a fast failure can look like a fast channel). */
  rejectedInWindow: number
}

export type IpcChannelLatencySummary = {
  /** The window size each entry's quantiles are computed over. */
  capacity: number
  /** Distinct channels measured since the process started, whether or not they are listed below. */
  channelsObserved: number
  /** Completions counted but not kept because `maxChannels` was reached. Zero on any ordinary process. */
  untrackedCalls: number
  /**
   * `records` = at least one channel completed a call; `no-calls-observed` = nothing reached the producer.
   * The second one is not "the application was fast": it also describes a process that never served a call.
   */
  status: 'records' | 'no-calls-observed'
  /** Worst tail first, at most `limit` entries. Empty only when `status` is `no-calls-observed`. */
  channels: IpcChannelLatencySummaryEntry[]
  /** Channels measured but not listed because of `limit`. */
  omitted: number
}

export type IpcChannelLatencyInput = {
  capacity?: number
  maxChannels?: number
  limit?: number
}

export type IpcChannelLatency = {
  /** Records one completion. Bounded work: a map lookup plus three array writes. */
  record: (channel: string, durationMs: number, outcome?: { rejected?: boolean }) => void
  summary: () => IpcChannelLatencySummary
  /** Test seam: forget everything without rebuilding the accumulator. */
  clear: () => void
}

type ChannelWindow = {
  durations: Float64Array
  rejected: Uint8Array
  /** Next slot to overwrite; the window is full once `observed >= capacity`. */
  cursor: number
  observed: number
  maxMs: number
}

const positiveInt = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback

/** Nearest rank: the smallest sample at or above the quantile, clamped into the array. */
const nearestRank = (sorted: Float64Array, quantile: number): number => {
  if (sorted.length === 0) return 0
  const rank = Math.ceil(quantile * sorted.length) - 1
  const index = Math.min(Math.max(rank, 0), sorted.length - 1)
  return sorted[index] as number
}

export const createIpcChannelLatency = (input: IpcChannelLatencyInput = {}): IpcChannelLatency => {
  const capacity = positiveInt(input.capacity, IPC_CHANNEL_LATENCY_CAPACITY)
  const maxChannels = positiveInt(input.maxChannels, IPC_CHANNEL_LATENCY_MAX_CHANNELS)
  const limit = positiveInt(input.limit, IPC_CHANNEL_LATENCY_SUMMARY_LIMIT)
  const windows = new Map<string, ChannelWindow>()
  let untrackedCalls = 0

  const record = (channel: string, durationMs: number, outcome?: { rejected?: boolean }): void => {
    // A duration that is not a finite, non-negative number is not a measurement: counting it as zero would
    // pull every median down with a value nobody observed.
    if (typeof channel !== 'string' || channel.length === 0) return
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    let window = windows.get(channel)
    if (window === undefined) {
      if (windows.size >= maxChannels) {
        untrackedCalls += 1
        return
      }
      window = {
        durations: new Float64Array(capacity),
        rejected: new Uint8Array(capacity),
        cursor: 0,
        observed: 0,
        maxMs: 0
      }
      windows.set(channel, window)
    }
    const slot = window.cursor
    window.durations[slot] = durationMs
    window.rejected[slot] = outcome?.rejected === true ? 1 : 0
    window.cursor = (slot + 1) % capacity
    window.observed += 1
    if (durationMs > window.maxMs) window.maxMs = durationMs
  }

  const summarise = (channel: string, window: ChannelWindow): IpcChannelLatencySummaryEntry => {
    const samples = Math.min(window.observed, capacity)
    // Copied before sorting: the ring's own order is the recency order, and a summary must not reorder it.
    const durations = window.durations.slice(0, samples)
    durations.sort()
    let rejectedInWindow = 0
    for (let index = 0; index < samples; index += 1) {
      rejectedInWindow += window.rejected[index] as number
    }
    return {
      channel,
      observed: window.observed,
      windowSamples: samples,
      p50Ms: nearestRank(durations, 0.5),
      p95Ms: nearestRank(durations, 0.95),
      windowMaxMs: (durations[samples - 1] as number | undefined) ?? 0,
      maxMs: window.maxMs,
      rejectedInWindow
    }
  }

  const summary = (): IpcChannelLatencySummary => {
    if (windows.size === 0) {
      return {
        capacity,
        channelsObserved: 0,
        untrackedCalls,
        status: 'no-calls-observed',
        channels: [],
        omitted: 0
      }
    }
    const entries: IpcChannelLatencySummaryEntry[] = []
    for (const [channel, window] of windows) entries.push(summarise(channel, window))
    // Worst tail first: the list exists to point at what needs work, and the tie-break on the median keeps
    // two channels with the same p95 in a stable order instead of the map's incidental one.
    entries.sort((left, right) => right.p95Ms - left.p95Ms || right.p50Ms - left.p50Ms)
    return {
      capacity,
      channelsObserved: windows.size,
      untrackedCalls,
      status: 'records',
      channels: entries.slice(0, limit),
      omitted: Math.max(0, entries.length - limit)
    }
  }

  const clear = (): void => {
    windows.clear()
    untrackedCalls = 0
  }

  return { record, summary, clear }
}

/** The process-wide accumulator the IPC adapter records into; the support bundle reads its summary. */
export const sharedIpcChannelLatency: IpcChannelLatency = createIpcChannelLatency()

/**
 * The local Web RPC face's window. Same shape, same factory, deliberately a *second* instance: when the app
 * serves its Web UI (the headless service, or the browser tab it prints), the same command names travel over
 * an HTTP socket instead of Electron IPC. Averaging both faces into one median would erase the difference a
 * reader opens this bundle to find — a channel that is fast in-process and slow over the socket, or the
 * reverse — so the bundle carries them as two sections rather than one blended list.
 */
export const sharedWebRpcChannelLatency: IpcChannelLatency = createIpcChannelLatency()
