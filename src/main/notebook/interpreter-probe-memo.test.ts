import { describe, expect, it } from 'vitest'
import { createInterpreterProbeMemo } from './interpreter-probe-memo'

// A memo is only allowed to be fast, never to be wrong: every case below pins one of the three rules the
// module's header states (fingerprint re-stat'ed on read, unstattable path never memoised, negative answer
// bounded), plus the two shapes that make it useful (bursts join, writes clear).

const counter = (): { probe: () => Promise<string>; calls: () => number } => {
  let calls = 0
  return {
    probe: async (): Promise<string> => {
      calls += 1
      return `3.${calls}`
    },
    calls: () => calls
  }
}

describe('interpreter probe memo', () => {
  it('answers from the memo while the binary fingerprint is unchanged', async () => {
    const memo = createInterpreterProbeMemo({ fingerprint: () => 'm1:100' })
    const { probe, calls } = counter()

    await expect(memo.read('k', '/envs/a/bin/python', probe)).resolves.toBe('3.1')
    await expect(memo.read('k', '/envs/a/bin/python', probe)).resolves.toBe('3.1')

    expect(calls()).toBe(1)
    expect(memo.size()).toBe(1)
  })

  it('probes again as soon as the fingerprint changes (an upgraded interpreter)', async () => {
    let fingerprint = 'm1:100'
    const memo = createInterpreterProbeMemo({ fingerprint: () => fingerprint })
    const { probe, calls } = counter()

    await memo.read('k', '/envs/a/bin/python', probe)
    fingerprint = 'm2:200'
    await expect(memo.read('k', '/envs/a/bin/python', probe)).resolves.toBe('3.2')

    expect(calls()).toBe(2)
  })

  it('probes again after the bounded age, and still answers before it', async () => {
    let now = 1_000
    const memo = createInterpreterProbeMemo({
      ttlMs: 60_000,
      now: () => now,
      fingerprint: () => 'm1:100'
    })
    const { probe, calls } = counter()

    await memo.read('k', '/envs/a/bin/python', probe)
    now += 59_000
    await expect(memo.read('k', '/envs/a/bin/python', probe)).resolves.toBe('3.1')
    expect(calls()).toBe(1)

    now += 2_000
    await expect(memo.read('k', '/envs/a/bin/python', probe)).resolves.toBe('3.2')
    expect(calls()).toBe(2)
  })

  it('never memoises a path it cannot fingerprint — there would be nothing to invalidate against', async () => {
    const memo = createInterpreterProbeMemo({ fingerprint: () => undefined })
    const { probe, calls } = counter()

    await memo.read('k', '/envs/gone/bin/python', probe)
    await memo.read('k', '/envs/gone/bin/python', probe)

    expect(calls()).toBe(2)
    expect(memo.size()).toBe(0)
  })

  it('memoises a negative answer only for the bounded age', async () => {
    let now = 0
    // Held in an object because the value only changes for the second half of the case; the probe closes
    // over it so the memo cannot see the change until its age allows another probe.
    const state: { answer: string | undefined } = { answer: undefined }
    const memo = createInterpreterProbeMemo({
      ttlMs: 1_000,
      now: () => now,
      fingerprint: () => 'm1:100'
    })
    let calls = 0
    const probe = async (): Promise<string | undefined> => {
      calls += 1
      return state.answer
    }

    await expect(memo.read('k', '/envs/r/bin/R', probe)).resolves.toBeUndefined()
    expect(calls).toBe(1)

    // Inside the age the negative answer stands — the row keeps saying what the last probe found.
    now += 500
    await expect(memo.read('k', '/envs/r/bin/R', probe)).resolves.toBeUndefined()
    expect(calls).toBe(1)

    // After it, the probe runs again and the row can recover without any explicit invalidation.
    state.answer = '4.5.3'
    now += 600
    await expect(memo.read('k', '/envs/r/bin/R', probe)).resolves.toBe('4.5.3')
    expect(calls).toBe(2)
  })

  it('joins a probe that is already running instead of spawning a second one', async () => {
    const memo = createInterpreterProbeMemo({ fingerprint: () => 'm1:100' })
    let release!: (value: string) => void
    let calls = 0
    const slow = (): Promise<string> => {
      calls += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }

    const first = memo.read('k', '/envs/a/bin/python', slow)
    const second = memo.read('k', '/envs/a/bin/python', slow)
    release('3.12.4')

    await expect(Promise.all([first, second])).resolves.toEqual(['3.12.4', '3.12.4'])
    expect(calls).toBe(1)
  })

  it('forgets everything on clear — what the env write paths call', async () => {
    const memo = createInterpreterProbeMemo({ fingerprint: () => 'm1:100' })
    const { probe, calls } = counter()

    await memo.read('k', '/envs/a/bin/python', probe)
    memo.clear()
    expect(memo.size()).toBe(0)
    await expect(memo.read('k', '/envs/a/bin/python', probe)).resolves.toBe('3.2')
    expect(calls()).toBe(2)
  })

  it('does not grow without bound on a machine with many envs', async () => {
    const memo = createInterpreterProbeMemo({ fingerprint: () => 'm1:100', maxEntries: 3 })
    const { probe } = counter()

    for (const name of ['a', 'b', 'c', 'd', 'e'])
      await memo.read(name, `/envs/${name}/bin/python`, probe)

    expect(memo.size()).toBeLessThanOrEqual(3)
  })
})
