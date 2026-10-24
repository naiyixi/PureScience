import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  identifyExecutable,
  withVersionProbeCache,
  type ExecutableIdentity,
  type VersionProbe
} from './version-probe-cache'

const present = (identity: string) => async (): Promise<ExecutableIdentity> => ({
  kind: 'present',
  identity
})
const missing = async (): Promise<ExecutableIdentity> => ({ kind: 'missing' })
const unknown = async (): Promise<ExecutableIdentity> => ({ kind: 'unknown' })

describe('withVersionProbeCache', () => {
  it('probes once and answers the second call from the file identity', async () => {
    const probe = vi.fn<VersionProbe>(async () => '1.2.3')
    const cached = withVersionProbeCache(probe, { identify: present('100:10') })

    await expect(cached('/usr/local/bin/agent')).resolves.toBe('1.2.3')
    await expect(cached('/usr/local/bin/agent')).resolves.toBe('1.2.3')

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('probes again when the executable changed in place', async () => {
    const probe = vi.fn<VersionProbe>(async () => '1.2.3')
    let identity = '100:10'
    const cached = withVersionProbeCache(probe, {
      identify: async () => ({ kind: 'present', identity })
    })

    await cached('/usr/local/bin/agent')
    identity = '200:11'
    probe.mockResolvedValueOnce('2.0.0')

    await expect(cached('/usr/local/bin/agent')).resolves.toBe('2.0.0')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('keys answers per path so one binary cannot answer for another', async () => {
    const probe = vi.fn<VersionProbe>(async (path) => (path.endsWith('a') ? 'a-1' : 'b-1'))
    const cached = withVersionProbeCache(probe, { identify: present('100:10') })

    await expect(cached('/bin/a')).resolves.toBe('a-1')
    await expect(cached('/bin/b')).resolves.toBe('b-1')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('skips the spawn when the path holds no file', async () => {
    const probe = vi.fn<VersionProbe>(async () => '1.2.3')
    const cached = withVersionProbeCache(probe, { identify: missing })

    await expect(cached('/nope/agent')).resolves.toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })

  it('still probes when the identity could not be established', async () => {
    const probe = vi.fn<VersionProbe>(async () => '1.2.3')
    const cached = withVersionProbeCache(probe, { identify: unknown })

    await expect(cached('/maybe/agent')).resolves.toBe('1.2.3')
    await expect(cached('/maybe/agent')).resolves.toBe('1.2.3')
    // Nothing is remembered without an identity, so both calls pay the probe.
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not remember a failed probe', async () => {
    const probe = vi
      .fn<VersionProbe>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('1.2.3')
    const cached = withVersionProbeCache(probe, { identify: present('100:10') })

    await expect(cached('/usr/local/bin/agent')).resolves.toBeUndefined()
    await expect(cached('/usr/local/bin/agent')).resolves.toBe('1.2.3')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('shares one spawn between concurrent callers', async () => {
    let release: (value: string) => void = () => undefined
    const probe = vi.fn<VersionProbe>(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    const cached = withVersionProbeCache(probe, { identify: present('100:10') })

    const first = cached('/usr/local/bin/agent')
    const second = cached('/usr/local/bin/agent')
    // Both callers first await their identity lookup, so let a few microtask turns pass before the
    // shared spawn is observable as in-flight.
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
    release('9.9.9')

    await expect(first).resolves.toBe('9.9.9')
    await expect(second).resolves.toBe('9.9.9')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('releases the in-flight slot so a failed concurrent run can be retried', async () => {
    const probe = vi
      .fn<VersionProbe>()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce('1.2.3')
    const cached = withVersionProbeCache(probe, { identify: present('100:10') })

    await expect(cached('/usr/local/bin/agent')).rejects.toThrow('spawn failed')
    await expect(cached('/usr/local/bin/agent')).resolves.toBe('1.2.3')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('bounds remembered answers', async () => {
    const probe = vi.fn<VersionProbe>(async () => '1.2.3')
    const cached = withVersionProbeCache(probe, { identify: present('100:10'), maxEntries: 2 })

    await cached('/bin/one')
    await cached('/bin/two')
    await cached('/bin/three') // evicts the oldest answer, for `/bin/one`
    await cached('/bin/two') // still remembered
    expect(probe).toHaveBeenCalledTimes(3)

    await cached('/bin/one') // evicted, so it is probed again
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('probes anyway when the identity lookup itself throws', async () => {
    const probe = vi.fn<VersionProbe>(async () => '1.2.3')
    const cached = withVersionProbeCache(probe, {
      identify: async () => {
        throw new Error('EIO')
      }
    })

    await expect(cached('/usr/local/bin/agent')).resolves.toBe('1.2.3')
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('identifyExecutable', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'version-probe-cache-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports a present file with an identity that moves when the bytes move', async () => {
    const binary = join(root, 'agent')
    await writeFile(binary, 'v1')
    const first = await identifyExecutable(binary)
    expect(first.kind).toBe('present')

    await writeFile(binary, 'a longer payload')
    const second = await identifyExecutable(binary)
    expect(second.kind).toBe('present')
    expect(second).not.toEqual(first)

    // Same bytes and same timestamps => same identity, which is what makes the memoisation exact.
    const third = await identifyExecutable(binary)
    expect(third).toEqual(second)
  })

  it('reports a symlink target identity, since the target answers the probe', async () => {
    const target = join(root, 'agent-2.1.0')
    await writeFile(target, 'v1')
    await utimes(target, 1_600_000_000, 1_600_000_000)
    const identity = await identifyExecutable(target)
    expect(identity.kind).toBe('present')
  })

  it('reports a missing path as missing on POSIX and as unknown on Windows', async () => {
    const absent = join(root, 'not-installed')
    await expect(identifyExecutable(absent, 'darwin')).resolves.toEqual({ kind: 'missing' })
    await expect(identifyExecutable(absent, 'linux')).resolves.toEqual({ kind: 'missing' })
    // A Windows probe runs through a shell, so `PATH`/`PATHEXT` may answer for a name `stat` cannot see.
    await expect(identifyExecutable(absent, 'win32')).resolves.toEqual({ kind: 'unknown' })
  })
})
