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

  // The Web face is the same reading for the calls a browser makes. It is a separate seam with its own ways to
  // be absent: a server that never records (the window stays empty in production), a section nobody writes, a
  // composition root that passes the desktop summary twice. Each assertion names the shape of its absence.
  it('records from the Web RPC dispatch, rejections included', () => {
    const server = read('src/main/web-service/http-server.ts')

    expect(server).toContain("from '../diagnostics/ipc-channel-latency'")
    expect(server).toContain('sharedWebRpcChannelLatency.record(')
    // Recorded on both exits: a channel that always fails would otherwise look like a channel nobody called.
    expect(server).toContain('rejected: true')
    // …and only after the request reached a command. A malformed body or an unknown channel is refused earlier
    // in this same handler, and counting those would let a probing client flatten a real channel's median.
    const dispatch = server.indexOf('const result = await commandClient.invoke(')
    const recorded = server.indexOf('sharedWebRpcChannelLatency.record(', dispatch)
    const validated = server.indexOf('const parsed = webRpcRequestSchema.safeParse(body)')
    expect(validated).toBeGreaterThan(0)
    expect(validated).toBeLessThan(dispatch)
    expect(recorded).toBeGreaterThan(dispatch)
  })

  it('writes the Web face as its own section, described in the bundle README', () => {
    const bundle = read('src/main/diagnostics/support-bundle.ts')

    expect(bundle).toContain("'diagnostics/web-rpc-channel-latency.json'")
    expect(bundle).toContain('webRpcChannelLatency: IpcChannelLatencySummary')
    expect(bundle).toContain('diagnostics/web-rpc-channel-latency.json\n')
  })

  it('passes the Web face summary from the composition root, not a second copy of the desktop one', () => {
    const composition = read('src/main/ipc.ts')

    expect(composition).toContain('webRpcChannelLatency: sharedWebRpcChannelLatency.summary()')
    // Two sections that read the same accumulator would look like two faces that agree, which is the one thing
    // this pair of readings must not claim on its own.
    expect(composition).not.toContain('webRpcChannelLatency: sharedIpcChannelLatency.summary()')
  })
})
