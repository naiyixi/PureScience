import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearInterpreterProbeCache, defaultDiscoveryDeps } from './environment-discovery'

// The memo's own rules are covered in `interpreter-probe-memo.test.ts`. This file is the OTHER half: that
// the production discovery path actually goes through it. A memo nobody wired is a pure module with a
// passing suite — the shape this repo has been bitten by before.

afterEach(() => clearInterpreterProbeCache())

describe('discovery probes are memoised on the production path', () => {
  it('does not start Rscript twice for the same interpreter inside the memo age', async () => {
    clearInterpreterProbeCache()
    let starts = 0
    const deps = defaultDiscoveryDeps('/tmp/ps-probe-memo-root', undefined, {
      platform: 'darwin',
      exec: async () => {
        starts += 1
        return { stdout: 'TRUE', stderr: '' }
      }
    })
    // Any path that exists: `rscriptFor` leaves a path without an `R` basename untouched and the exec is
    // stubbed, so this exercises the memo's fingerprint (a real stat) without spawning anything.
    const interpreter = process.execPath

    await expect(deps.rRunnable(interpreter)).resolves.toBe(true)
    await expect(deps.rRunnable(interpreter)).resolves.toBe(true)
    expect(starts).toBe(1)

    // And the invalidation the env write paths call really does force a fresh probe.
    clearInterpreterProbeCache()
    await expect(deps.rRunnable(interpreter)).resolves.toBe(true)
    expect(starts).toBe(2)
  })

  it('re-probes when the interpreter binary itself is replaced', async () => {
    clearInterpreterProbeCache()
    const dir = await mkdtemp(join(tmpdir(), 'ps-probe-memo-'))
    const interpreter = join(dir, 'R')
    await writeFile(interpreter, 'stub')
    let starts = 0
    const deps = defaultDiscoveryDeps('/tmp/ps-probe-memo-root', undefined, {
      platform: 'darwin',
      exec: async () => {
        starts += 1
        return { stdout: 'TRUE', stderr: '' }
      }
    })

    await deps.rRunnable(interpreter)
    await deps.rRunnable(interpreter)
    expect(starts).toBe(1)

    // A different binary at the same path: mtime is the fingerprint the memo re-stats on every read, so
    // replacing the interpreter must miss without anyone remembering to clear anything.
    await writeFile(interpreter, 'stub-replaced')
    await utimes(interpreter, new Date(), new Date(Date.now() + 5_000))
    await deps.rRunnable(interpreter)
    expect(starts).toBe(2)

    await rm(dir, { recursive: true, force: true })
  })
})
