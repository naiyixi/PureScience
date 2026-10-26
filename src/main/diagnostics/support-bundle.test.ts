import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import * as tar from 'tar'

import {
  createSupportBundle,
  listSupportBundleEntries,
  type SupportBundleInput
} from './support-bundle'
import { createStallRecordRing } from './stall-record-ring'
import { summarizeHostTimeline } from './host-stall-sampler'
import { readShippedModelWeightManifest } from '../engines/model-weight-manifest-file'

const roots: string[] = []

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'support-bundle-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const HOME_DIR = '/Users/example-user'

const baseInput = async (root: string): Promise<SupportBundleInput> => {
  await mkdir(join(root, 'logs'), { recursive: true })
  await mkdir(join(root, 'out'), { recursive: true })
  return {
    logDir: join(root, 'logs'),
    outPath: join(root, 'out', 'purescience-support.tar.gz'),
    versions: { app: '1.75.0', electron: '43.7.5', chrome: '140.0.0.0', node: '22.22.3' },
    platform: 'darwin',
    arch: 'arm64',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    packaged: true,
    storageLocation: 'custom',
    localParsingModels: {
      source: 'packaged',
      present: true,
      state: 'usable',
      entryCount: 1,
      problems: []
    },
    stalls: createStallRecordRing().summary(),
    // Built by the producer rather than written by hand: a fixture that invents its own shape stops testing
    // the section the moment the summarizer changes.
    hostTimeline: summarizeHostTimeline({
      snapshot: { samples: [], paging: [] },
      intervalMs: 250,
      platform: 'darwin',
      nowMs: 0
    }),
    homeDir: HOME_DIR,
    userName: 'example-user',
    now: () => new Date('2026-09-28T00:00:00.000Z')
  }
}

const extractTo = async (bundlePath: string, target: string): Promise<void> => {
  await mkdir(target, { recursive: true })
  await tar.extract({ file: bundlePath, cwd: target })
}

const readFrom = async (target: string, relative: string): Promise<string> =>
  readFile(join(target, relative), 'utf8')

describe('support bundle', () => {
  it('writes the manifest, environment, runtime summary, readme and logs', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    await writeFile(join(root, 'logs', 'purescience.log'), 'boot ok\n', 'utf8')

    const result = await createSupportBundle(input)

    expect(result.entries).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'environment.json',
        'runtime.json',
        'parsing-models.json',
        'README.txt'
      ])
    )
    expect(result.entries).toContain('logs/purescience.log')
    expect(result.bytes).toBeGreaterThan(0)

    const target = join(root, 'extracted')
    await extractTo(result.path, target)
    const manifest = JSON.parse(await readFrom(target, 'manifest.json'))
    expect(manifest).toMatchObject({
      generatedAt: '2026-09-28T00:00:00.000Z',
      application: '1.75.0',
      electron: '43.7.5',
      node: '22.22.3',
      platform: 'darwin',
      arch: 'arm64',
      timezone: 'Asia/Shanghai'
    })
  })

  it('carries the storage location class but never a path', async () => {
    const root = await createRoot()
    const input = await baseInput(root)

    const result = await createSupportBundle(input)
    const target = join(root, 'extracted')
    await extractTo(result.path, target)

    const runtime = await readFrom(target, 'runtime.json')
    expect(JSON.parse(runtime)).toMatchObject({ storageLocation: 'custom' })
    expect(runtime).not.toContain(HOME_DIR)
    expect(runtime).not.toContain('/')
  })

  it('carries the local-parsing-model reading, and never the path it was read from', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    // A real manifest on a real filesystem, read through the production entry point rather than a hand-built
    // literal: what the bundle carries is only as honest as the reader that produced it.
    const manifestDir = join(root, 'resources', 'model-weights')
    await mkdir(manifestDir, { recursive: true })
    await writeFile(
      join(manifestDir, 'manifest.json'),
      JSON.stringify({
        schema: 1,
        revision: '2026-10-16.1',
        entries: [
          {
            id: 'structure-recognition-primary',
            revision: 'zenodo-10.5281/zenodo.8300489',
            publisher: 'example publisher',
            url: 'https://example.invalid/weights/models.zip',
            sha256: 'a'.repeat(64),
            bytes: 298662033,
            license: 'CC-BY-4.0',
            kind: 'structure-recognition'
          }
        ]
      }),
      'utf8'
    )
    const reading = readShippedModelWeightManifest({ fromDir: join(root, 'out', 'main') })
    input.localParsingModels = reading.report

    const result = await createSupportBundle(input)
    const target = join(root, 'extracted')
    await extractTo(result.path, target)

    expect(JSON.parse(await readFrom(target, 'parsing-models.json'))).toEqual({
      source: 'dev',
      present: true,
      state: 'usable',
      entryCount: 1,
      problems: []
    })
    // The reader knows the path; the bundle must not. The temp root here is the stand-in for a home
    // directory, and it is exactly what this module exists to keep out of a file that leaves the device.
    for (const entry of result.entries) {
      const contents = await readFrom(target, entry)
      expect(contents).not.toContain(root)
    }
  })

  it('reports an invalid shipped manifest as invalid, by field, instead of as an empty listing', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    const manifestDir = join(root, 'resources', 'model-weights')
    await mkdir(manifestDir, { recursive: true })
    await writeFile(
      join(manifestDir, 'manifest.json'),
      JSON.stringify({
        schema: 1,
        revision: '2026-10-16.1',
        // No digest: exactly the publisher error the shape rules exist to catch, and one the reader must not
        // present as "this build ships no models".
        entries: [
          { id: 'x', revision: 'r1', publisher: 'p', url: 'https://example.invalid/x', bytes: 1 }
        ]
      }),
      'utf8'
    )
    input.localParsingModels = readShippedModelWeightManifest({
      fromDir: join(root, 'out', 'main')
    }).report

    const result = await createSupportBundle(input)
    const target = join(root, 'extracted')
    await extractTo(result.path, target)

    const report = JSON.parse(await readFrom(target, 'parsing-models.json')) as {
      state: string
      reason?: string
      entryCount?: number
      problems: { field: string }[]
    }
    expect(report.state).toBe('invalid')
    expect(report.reason).toBe('failed-validation')
    expect(report.problems.map((problem) => problem.field)).toContain('sha256')
    // No count at all: the entries did not validate, so there is nothing to count.
    expect(report.entryCount).toBeUndefined()
  })

  it('scrubs the home directory, the user name and secret-shaped values out of copied logs', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    await writeFile(
      join(root, 'logs', 'purescience.log'),
      [
        `opened ${HOME_DIR}/work/project`,
        'stack at example-user/Library/Application Support',
        'provider api_key = "abcdef123456"',
        'Authorization: Bearer ghu_1234567890abcdef'
      ].join('\n'),
      'utf8'
    )

    const result = await createSupportBundle(input)
    expect(result.redactions).toBeGreaterThanOrEqual(3)

    const target = join(root, 'extracted')
    await extractTo(result.path, target)
    const log = await readFrom(target, 'logs/purescience.log')
    expect(log).not.toContain(HOME_DIR)
    expect(log).not.toContain('example-user')
    expect(log).not.toContain('abcdef123456')
    expect(log).not.toContain('ghu_1234567890abcdef')
    expect(log).toContain('<path>')
    expect(log).toContain('[REDACTED]')
  })

  it('refuses to produce a bundle when a leak survives scrubbing', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    await writeFile(join(root, 'logs', 'purescience.log'), `secret at ${HOME_DIR}\n`, 'utf8')

    // The scrubbing pass is disabled on purpose: the read-back check must still catch what would ship.
    await expect(createSupportBundle({ ...input, scrub: false })).rejects.toThrow(
      /Support bundle aborted/
    )
    await expect(stat(input.outPath)).rejects.toThrow()
  })

  it('copies the newest logs first and stops at the byte cap', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    const rotated = join(root, 'logs', 'purescience.1.log')
    const active = join(root, 'logs', 'purescience.log')
    await writeFile(rotated, 'old'.repeat(200), 'utf8')
    await writeFile(active, 'new'.repeat(200), 'utf8')
    // Ordering is by modification time, so the times are set explicitly: relying on two writes landing in a
    // different clock tick holds on one platform and not on another (Windows reports them equal, and this
    // test then failed there).
    const earlier = new Date('2026-09-27T00:00:00.000Z')
    const later = new Date('2026-09-28T00:00:00.000Z')
    await utimes(rotated, earlier, earlier)
    await utimes(active, later, later)

    // One log fits the cap, not two.
    const result = await createSupportBundle({ ...input, maxLogBytes: 700 })

    expect(result.entries).toContain('logs/purescience.log')
    expect(result.entries).not.toContain('logs/purescience.1.log')
  })

  it('prefers the active log when the filesystem cannot separate two writes', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    const rotated = join(root, 'logs', 'purescience.1.log')
    const active = join(root, 'logs', 'purescience.log')
    await writeFile(rotated, 'old'.repeat(200), 'utf8')
    await writeFile(active, 'new'.repeat(200), 'utf8')
    // Identical times: without a tie-breaker the order is arbitrary, and here that would decide which log
    // survives the cap.
    const same = new Date('2026-09-28T00:00:00.000Z')
    await utimes(rotated, same, same)
    await utimes(active, same, same)

    const result = await createSupportBundle({ ...input, maxLogBytes: 700 })

    expect(result.entries).toContain('logs/purescience.log')
    expect(result.entries).not.toContain('logs/purescience.1.log')
  })

  it('lists the entries of a written bundle without extracting it', async () => {
    const root = await createRoot()
    const input = await baseInput(root)

    const result = await createSupportBundle(input)
    await expect(listSupportBundleEntries(result.path)).resolves.toEqual(
      expect.arrayContaining(['manifest.json', 'README.txt'])
    )
  })
})

describe('support bundle: trajectory section', () => {
  const trajectorySession = {
    id: 'session-1',
    status: 'completed',
    messages: [{ id: 'm1', role: 'user', content: '看看这份数据', artifactIds: ['v1'] }],
    providers: [{ id: 'p1', apiKey: 'sk-live-SHOULDNOTSHIP', keyRef: 'enc:v1:SHOULDNOTSHIP' }]
  }

  it('carries the redacted trajectory and leaves no credential in the archive', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    const result = await createSupportBundle({
      ...input,
      trajectory: {
        productVersion: '2.19.0',
        sessionId: 'session-1',
        session: trajectorySession,
        artifacts: [{ artifactVersionId: 'v1' }]
      }
    })

    expect(result.entries).toContain('trajectory/session.json')
    expect(result.entries).toContain('trajectory/manifest.json')
    expect(result.entries).toContain('trajectory/checksums.sha256')

    const target = join(root, 'extracted')
    await extractTo(result.path, target)
    const session = await readFrom(target, 'trajectory/session.json')
    expect(session).toContain('REDACTED')
    expect(session).not.toContain('SHOULDNOTSHIP')
    // The archive-level leak check reads what actually shipped, so a bundle that kept a secret would not exist.
    const manifest = await readFrom(target, 'trajectory/manifest.json')
    expect(manifest).toContain('"toolCalls": "absent:not-collected"')
  })

  it('refuses to hand over a bundle whose trajectory still carries a secret', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    await expect(
      createSupportBundle({
        ...input,
        // The scrubber is bypassed on purpose: the read-back gate is what must refuse, not the scrubber.
        scrub: false,
        trajectory: {
          productVersion: '2.19.0',
          sessionId: 'session-1',
          session: trajectorySession,
          scrub: false
        }
      })
      // Separator-agnostic on purpose: the archive path is built with `join`, so a Windows runner reports
      // `trajectory\session.json` where POSIX reports `trajectory/session.json`. Pinning one separator is a
      // cross-platform red that has nothing to do with the behaviour under test.
    ).rejects.toThrow(/trajectory.*still contains a secret/u)

    // Nothing left behind: a refused bundle must not leave a half-written archive.
    await expect(stat(input.outPath)).rejects.toThrow()
  })

  it('carries the watchdog records, with the counters that say how much of the history is missing', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    const ring = createStallRecordRing({
      capacity: 2,
      now: () => new Date('2026-10-25T08:00:00.000Z')
    })
    const record = {
      windowMs: 4_200,
      lateMs: 3_700,
      cpuMs: 3_900,
      cpuShare: 0.93,
      attribution: 'cpu-bound-in-process' as const,
      stack: {
        status: 'profiled' as const,
        mainThreadMs: 3_800,
        unobservedMs: 0,
        samples: 76,
        frames: [{ frame: 'save (src/main/store/save.ts:42)', samples: 76 }]
      },
      host: {
        status: 'sampled' as const,
        intervalMs: 250,
        stallMs: 4_200,
        samples: 16,
        expectedSamples: 17,
        continuity: 'kept-sampling' as const,
        freeMemMbMin: 84,
        pageouts: 0
      },
      freeMemMb: 96,
      loadAvg1m: 3.25
    }
    ring.record(record)
    ring.record({ ...record, windowMs: 6_000 })
    ring.record({ ...record, windowMs: 8_000 })
    await writeFile(join(root, 'logs', 'purescience.log'), 'boot ok\n', 'utf8')

    const result = await createSupportBundle({ ...input, stalls: ring.summary() })

    expect(result.entries).toContain('diagnostics/event-loop-stalls.json')
    const target = join(root, 'extracted')
    await extractTo(result.path, target)
    const summary = JSON.parse(await readFrom(target, 'diagnostics/event-loop-stalls.json')) as {
      capacity: number
      observed: number
      dropped: number
      status: string
      records: { windowMs: number; at: string; stack: { frames: { frame: string }[] } }[]
    }
    // Three stalls were seen, two are kept: the bundle must say both, or "we saw 16" becomes "we saw the
    // last 16".
    expect(summary.observed).toBe(3)
    expect(summary.dropped).toBe(1)
    expect(summary.capacity).toBe(2)
    expect(summary.status).toBe('records')
    expect(summary.records.map((entry) => entry.windowMs)).toEqual([6_000, 8_000])
    // The stack and the observation clock both survive the trip: the frame is what names the blocking code,
    // and `at` is what lets a maintainer line the record up with the logs.
    expect(summary.records[1].stack.frames[0].frame).toBe('save (src/main/store/save.ts:42)')
    expect(summary.records[0].at).toBe('2026-10-25T08:00:00.000Z')
    // The logs still ship next to it: the section is the machine-readable tail, not a replacement.
    expect(result.entries).toContain('logs/purescience.log')
  })

  it('writes the stall section even when nothing stalled, and names that state', async () => {
    const root = await createRoot()
    const input = await baseInput(root)

    const result = await createSupportBundle(input)

    // Present-and-empty rather than absent: a missing file would be indistinguishable from an export that
    // silently stopped carrying the section.
    expect(result.entries).toContain('diagnostics/event-loop-stalls.json')
    const target = join(root, 'extracted')
    await extractTo(result.path, target)
    const summary = JSON.parse(await readFrom(target, 'diagnostics/event-loop-stalls.json')) as {
      status: string
      observed: number
      records: unknown[]
    }
    expect(summary.status).toBe('no-stalls-observed')
    expect(summary.observed).toBe(0)
    expect(summary.records).toEqual([])
  })

  // The half the stall records cannot answer: no window, no threshold, just the machine over the last few
  // minutes. This is the section a "it was slow for an hour" report needs.
  it('carries the machine timeline itself, with the window and the counters it was read from', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    const vmStat = (pageouts: number): string => `Pageouts:   ${pageouts}.\nSwapouts:   7.\n`

    const result = await createSupportBundle({
      ...input,
      hostTimeline: summarizeHostTimeline({
        snapshot: {
          samples: [
            { at: 1_000, cpuMs: 12, freeMemMb: 90, loadAvg1m: 3.5, rssMb: 210 },
            { at: 1_250, cpuMs: 40, freeMemMb: 61, loadAvg1m: 7.25, rssMb: 214 },
            { at: 1_500, cpuMs: 9, freeMemMb: 74, loadAvg1m: 5, rssMb: 216 }
          ],
          paging: [
            { at: 1_000, text: vmStat(900) },
            { at: 1_400, text: vmStat(940) }
          ],
          sampleCapacity: 1_200,
          pagingCapacity: 120,
          samplesDropped: 8_640,
          pagingDropped: 610
        },
        intervalMs: 250,
        platform: 'darwin',
        nowMs: Date.parse('2026-10-26T10:00:00.000Z')
      })
    })

    expect(result.entries).toContain('diagnostics/host-timeline.json')
    const target = join(root, 'extracted')
    await extractTo(result.path, target)
    const timeline = JSON.parse(await readFrom(target, 'diagnostics/host-timeline.json')) as {
      status: string
      capturedAt: string
      sampleCount: number
      samplesDropped: number
      sampleCapacity: number
      spanMs: number
      oldestAt: string
      newestAt: string
      samples: { at: string; cpuMs: number; freeMemMb: number }[]
      paging: {
        status: string
        dropped: number
        readings: { pageouts: number; swapouts: number }[]
      }
    }

    expect(timeline.status).toBe('timeline')
    expect(timeline.sampleCount).toBe(3)
    expect(timeline.spanMs).toBe(500)
    expect(timeline.oldestAt).toBe(new Date(1_000).toISOString())
    expect(timeline.newestAt).toBe(new Date(1_500).toISOString())
    // The two numbers that keep "the sampler has been up for days" from reading as "this is all it saw".
    expect(timeline.sampleCapacity).toBe(1_200)
    expect(timeline.samplesDropped).toBe(8_640)
    // Per-sample values survive the archive: free memory between readings is the whole point of a timeline.
    expect(timeline.samples.map((entry) => entry.freeMemMb)).toEqual([90, 61, 74])
    expect(timeline.paging.readings.map((entry) => entry.pageouts)).toEqual([900, 940])
    expect(timeline.paging.readings[0].swapouts).toBe(7)
  })

  it('writes the timeline section when nothing was sampled, and names that state', async () => {
    const root = await createRoot()
    const input = await baseInput(root)

    const result = await createSupportBundle(input)

    // Present with a named empty state: an absent file and a section dropped by a bug would look identical,
    // and so would an empty list that meant "the machine was calm".
    expect(result.entries).toContain('diagnostics/host-timeline.json')
    const target = join(root, 'extracted')
    await extractTo(result.path, target)
    const timeline = JSON.parse(await readFrom(target, 'diagnostics/host-timeline.json')) as {
      status: string
      samples?: unknown[]
      paging: { status: string; reason: string }
    }
    expect(timeline.status).toBe('no-samples')
    expect(timeline.samples).toBeUndefined()
    expect(timeline.paging).toEqual({ status: 'unavailable', reason: 'no-counters-parsed' })
  })
})
