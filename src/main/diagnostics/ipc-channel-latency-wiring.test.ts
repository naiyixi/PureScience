import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Source-level on purpose, for the same reason as `slow-operation-ring-wiring`: the three sides of this seam
// never import each other in a way a unit test can observe end to end — the producer is created where the IPC
// adapter module loads, the bundle facts are assembled in the composition root, and the archive is written by a
// module that only sees the summary. A missing link is exactly the failure that has bitten this repository
// before: a reading that exists, is correct, and that no user can ever receive.
//
// Each assertion names what its absence would look like to a reader:
//   - no default sink  ⇒ the window is empty in production and only tests ever fill it ("no-calls-observed"
//     on every real bundle, which reads like a fast application);
//   - no file written  ⇒ the summary is computed and thrown away;
//   - no composition-root line ⇒ the bundle ships the empty default state forever.
const projectRoot = resolve(__dirname, '../../..')
const read = (relative: string): string => readFileSync(resolve(projectRoot, relative), 'utf8')

describe('the every-call latency window reaches the support bundle', () => {
  it('records from the IPC adapter without production opting in', () => {
    const adapter = read('src/main/diagnostics/ipc-rejection.ts')

    expect(adapter).toContain("from './ipc-channel-latency'")
    // The default sink is what makes the window exist in production; a sink only tests hand over is a
    // reading no user ever produces.
    expect(adapter).toContain('sharedIpcChannelLatency.record(')
    // Recorded on the way in *before* the threshold can return: a 12 ms call is what the median is made of.
    const completion = adapter.indexOf('const recordSlowSuccess = (): void => {')
    const recorded = adapter.indexOf('recordLatency(durationMs, false)', completion)
    const threshold = adapter.indexOf('SLOW_IPC_HANDLER_THRESHOLD_MS) return', completion)
    expect(recorded).toBeGreaterThan(completion)
    expect(threshold).toBeGreaterThan(recorded)
    // A rejection is a completion too, and it is counted as one: a channel that fails fast is not a fast one.
    expect(adapter).toContain('recordLatency(durationMs, true)')
  })

  it('writes the summary as its own section, described in the bundle README', () => {
    const bundle = read('src/main/diagnostics/support-bundle.ts')

    expect(bundle).toContain("'diagnostics/ipc-channel-latency.json'")
    expect(bundle).toContain('ipcChannelLatency: IpcChannelLatencySummary')
    // The README is the only place a reader learns what the file is; a section nobody describes is a file
    // they have to reverse-engineer.
    expect(bundle).toContain('diagnostics/ipc-channel-latency.json\n')
  })

  it('reads the accumulator in the composition root and hands it to the bundle', () => {
    const composition = read('src/main/ipc.ts')

    expect(composition).toContain("from './diagnostics/ipc-channel-latency'")
    expect(composition).toContain('ipcChannelLatency: sharedIpcChannelLatency.summary()')
  })
})
