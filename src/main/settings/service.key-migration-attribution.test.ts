import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The pass logs through the module-level logger, so the line itself is the evidence under test.
const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => logSpies
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

const { SettingsService } = await import('./service')
const { SettingsRepository } = await import('./repository')
const { sharedLoopHeldWindows } = await import('../diagnostics/loop-held-windows')

type CpuSample = { user: number; system: number }

const legacyProvider = {
  id: 'legacy-provider',
  type: 'custom' as const,
  name: 'Legacy',
  baseUrl: 'https://legacy.example/v1',
  model: 'legacy-model',
  apiEndpoints: ['openai' as const],
  keyRef: `plain:${Buffer.from('legacy-key', 'utf8').toString('base64')}`,
  keyMask: 'le•••••ey'
}

const migrationLine = (): Record<string, unknown> => {
  const call = logSpies.warn.mock.calls.find(
    ([message]) => message === 'settings key migration was slow'
  )
  if (!call) throw new Error('the migration line was not written')
  return call[1] as Record<string, unknown>
}

describe('legacy key migration attribution', () => {
  let dir: string
  let repository: InstanceType<typeof SettingsRepository>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osci-key-migration-attribution-'))
    repository = new SettingsRepository(dir)
    await repository.upsertProvider(legacyProvider)
    for (const spy of Object.values(logSpies)) spy.mockClear()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('names a pass whose wall time was not work instead of blaming the secret store', async () => {
    // The real reading this is drawn from: `encryption-available=22763345ms` with the watchdog's own
    // `cpuShare 0 / no-cpu-in-process` for the same gap. The clock advances on every reading while the
    // process spends no CPU at all.
    let clock = 1_000
    const cpu: CpuSample = { user: 0, system: 0 }
    const service = new SettingsService({
      repository,
      storageRoot: dir,
      clock: () => (clock += 1_500),
      cpuUsage: () => cpu
    })

    await service.getSettingsView()

    const line = migrationLine()
    expect(line).toMatchObject({
      attribution: 'no-cpu-in-process',
      cpuMs: 0,
      cpuShare: 0
    })
    expect(Number(line.totalMs)).toBeGreaterThan(250)
    expect(String(line.phases)).toContain('(no-cpu)')
  })

  it('still calls a pass that really ran the clock its own work', async () => {
    let clock = 1_000
    let cpu: CpuSample = { user: 0, system: 0 }
    const service = new SettingsService({
      repository,
      storageRoot: dir,
      // Every reading advances both clocks by the same amount: the process was running throughout.
      clock: () => (clock += 1_000),
      cpuUsage: () => {
        cpu = { user: cpu.user + 900_000, system: cpu.system }
        return cpu
      }
    })

    await service.getSettingsView()

    const line = migrationLine()
    expect(line).toMatchObject({ attribution: 'cpu-bound-in-process' })
    expect(String(line.phases)).not.toContain('(no-cpu)')
  })

  // The CPU share already says the process was barely running; the held split says how much of the pass fell
  // inside a window the loop never ran for, which is the number a reader subtracts from `totalMs`. The
  // window is written on the loop's own clock (what the stall watchdog records) and covers the whole pass,
  // so every measured millisecond has to be reported as held.
  it('says how much of the pass the loop was held for, not only how much CPU it used', async () => {
    // An epoch-based clock, like the other held-split tests: the wall reading has to be a real `Date.now()`
    // value for the wall→monotonic bridge to mean anything, so the same number feeds both the injected
    // clock and `Date.now()` (a pass that advances 1 500 ms per reading).
    let now = 1_760_000_000_000
    const clockSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cpu: CpuSample = { user: 0, system: 0 }
    const heldStart = performance.now() - 65_000
    sharedLoopHeldWindows.record(heldStart, heldStart + 130_000)
    const service = new SettingsService({
      repository,
      storageRoot: dir,
      clock: () => (now += 1_500),
      cpuUsage: () => cpu
    })

    try {
      await service.getSettingsView()

      const line = migrationLine()
      expect(Number(line.heldMs)).toBe(Number(line.totalMs))
      expect(line.ownMs).toBe(0)
    } finally {
      clockSpy.mockRestore()
    }
  })
})
