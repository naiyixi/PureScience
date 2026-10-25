import { describe, expect, it, vi } from 'vitest'

import { createCodexAdapterVersionProbe } from './agent-runtime-manager'

// `probe-codex` was the last uncached spawn on the startup critical path: every launch paid the
// managed adapter's own `--version` (measured 585 ms), for an answer that cannot change unless that
// file changes. These assertions pin the caching contract onto the wiring, not onto the generic
// helper (version-probe-cache.test.ts already covers the helper's own rules).

const pinnedIdentity = (): ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ kind: 'present' as const, identity: 'mtime:size' }))

describe('createCodexAdapterVersionProbe', () => {
  it('answers a repeat probe from memory instead of spawning again', async () => {
    const runAdapterVersion = vi.fn(async () => 'codex-acp 1.2.3')
    const identify = pinnedIdentity()
    const probe = createCodexAdapterVersionProbe(runAdapterVersion, { identify })

    await expect(probe('/managed/adapter')).resolves.toBe('codex-acp 1.2.3')
    await expect(probe('/managed/adapter')).resolves.toBe('codex-acp 1.2.3')

    expect(runAdapterVersion).toHaveBeenCalledTimes(1)
  })

  it('probes again when the adapter file identity changed', async () => {
    const runAdapterVersion = vi.fn(async () => 'codex-acp 1.2.3')
    let identity = 'first'
    const probe = createCodexAdapterVersionProbe(runAdapterVersion, {
      identify: async () => ({ kind: 'present' as const, identity })
    })

    await probe('/managed/adapter')
    identity = 'second'
    await probe('/managed/adapter')

    expect(runAdapterVersion).toHaveBeenCalledTimes(2)
  })

  it('never remembers a failed probe', async () => {
    // A spawn failure is machine-transient; caching it would read as "adapter broken" until the file
    // changed, which is the same refusal every other version probe in this app makes.
    const runAdapterVersion = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('codex-acp 1.2.3')
    const probe = createCodexAdapterVersionProbe(runAdapterVersion, { identify: pinnedIdentity() })

    await expect(probe('/managed/adapter')).resolves.toBeUndefined()
    await expect(probe('/managed/adapter')).resolves.toBe('codex-acp 1.2.3')
    expect(runAdapterVersion).toHaveBeenCalledTimes(2)
  })

  it('shares one spawn between concurrent callers', async () => {
    const runAdapterVersion = vi.fn(async () => 'codex-acp 1.2.3')
    const probe = createCodexAdapterVersionProbe(runAdapterVersion, { identify: pinnedIdentity() })

    await Promise.all([probe('/managed/adapter'), probe('/managed/adapter')])

    expect(runAdapterVersion).toHaveBeenCalledTimes(1)
  })
})
