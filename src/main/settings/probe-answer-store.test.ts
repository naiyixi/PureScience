// The probe-answer file is the part of the version cache that survives a restart, so these cases pin the
// two properties that make it safe: it answers only for the exact executable identity that produced the
// answer, and nothing it cannot read is allowed to become a version.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createProbeAnswerStore } from './probe-answer-store'
import { configureVersionProbeAnswerStore, withVersionProbeCache } from './version-probe-cache'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'probe-answer-store-'))
  configureVersionProbeAnswerStore(undefined)
})

afterEach(async () => {
  configureVersionProbeAnswerStore(undefined)
  await rm(root, { recursive: true, force: true })
})

const storeAt = (
  name = 'probe-answers.json',
  maxEntries?: number
): ReturnType<typeof createProbeAnswerStore> =>
  createProbeAnswerStore({
    filePath: join(root, name),
    ...(maxEntries === undefined ? {} : { maxEntries })
  })

describe('probe answer store', () => {
  it('answers a later process for the same executable identity', async () => {
    const first = storeAt()
    await first.load()
    first.set('key-opencode', '1.19.3')
    await first.flush()

    const second = storeAt()
    await second.load()

    expect(second.get('key-opencode')).toBe('1.19.3')
  })

  it('does not answer for an identity it never saw', async () => {
    const store = storeAt()
    await store.load()
    store.set('key-opencode', '1.19.3')
    await store.flush()

    const reloaded = storeAt()
    await reloaded.load()

    // A reinstalled binary has a different fingerprint, which is a different key: it must be probed.
    expect(reloaded.get('key-opencode-after-upgrade')).toBeUndefined()
  })

  it('ignores a corrupt file instead of failing the launch', async () => {
    await writeFile(join(root, 'probe-answers.json'), '{"version":1,"entries":', 'utf8')
    const store = storeAt()

    await expect(store.load()).resolves.toBeUndefined()
    expect(store.get('anything')).toBeUndefined()
  })

  it('ignores an entries document from another file version', async () => {
    await writeFile(
      join(root, 'probe-answers.json'),
      JSON.stringify({ version: 2, entries: { 'key-a': '9.9.9' } }),
      'utf8'
    )
    const store = storeAt()

    await store.load()

    expect(store.get('key-a')).toBeUndefined()
  })

  it('drops non-string answers rather than putting them in front of a reader', async () => {
    await writeFile(
      join(root, 'probe-answers.json'),
      JSON.stringify({ version: 1, entries: { 'key-a': { version: '1.0.0' }, 'key-b': '' } }),
      'utf8'
    )
    const store = storeAt()

    await store.load()

    expect(store.get('key-a')).toBeUndefined()
    expect(store.get('key-b')).toBeUndefined()
  })

  it('bounds what it keeps and writes the trimmed set', async () => {
    const store = storeAt('probe-answers.json', 2)
    await store.load()
    store.set('key-a', '1')
    store.set('key-b', '2')
    store.set('key-c', '3')
    await store.flush()

    const document = JSON.parse(await readFile(join(root, 'probe-answers.json'), 'utf8'))
    expect(Object.keys(document.entries)).toEqual(['key-b', 'key-c'])
  })

  it('writes through one chain so two quick answers cannot interleave', async () => {
    const store = storeAt()
    await store.load()
    store.set('key-a', '1')
    store.set('key-b', '2')
    await store.flush()

    const document = JSON.parse(await readFile(join(root, 'probe-answers.json'), 'utf8'))
    expect(document).toEqual({ version: 1, entries: { 'key-a': '1', 'key-b': '2' } })
  })
})

describe('version probe cache over a persistent store', () => {
  const identity = (identity: string) => async () => ({ kind: 'present' as const, identity })

  it('does not spawn again after a restart for an unchanged binary', async () => {
    const probe = vi.fn(async () => '1.19.3')
    const identify = identity('/opt/homebrew/bin/opencode:30:1792841234')

    const first = storeAt()
    await first.load()
    configureVersionProbeAnswerStore(first)
    await expect(
      withVersionProbeCache(probe, { identify })('/opt/homebrew/bin/opencode')
    ).resolves.toBe('1.19.3')
    await first.flush()

    // Second "launch": a fresh in-memory cache, the same file on disk.
    const second = storeAt()
    await second.load()
    configureVersionProbeAnswerStore(second)
    const restartedProbe = vi.fn(async () => '1.19.4')

    await expect(
      withVersionProbeCache(restartedProbe, { identify })('/opt/homebrew/bin/opencode')
    ).resolves.toBe('1.19.3')
    expect(restartedProbe).not.toHaveBeenCalled()
  })

  it('spawns again when the binary changed, even though the file has an answer', async () => {
    const first = storeAt()
    await first.load()
    configureVersionProbeAnswerStore(first)
    await withVersionProbeCache(
      vi.fn(async () => '1.19.3'),
      {
        identify: identity('/opt/homebrew/bin/opencode:30:1792841234')
      }
    )('/opt/homebrew/bin/opencode')
    await first.flush()

    const second = storeAt()
    await second.load()
    configureVersionProbeAnswerStore(second)
    const upgradedProbe = vi.fn(async () => '1.20.0')

    await expect(
      withVersionProbeCache(upgradedProbe, {
        identify: identity('/opt/homebrew/bin/opencode:31:1792849999')
      })('/opt/homebrew/bin/opencode')
    ).resolves.toBe('1.20.0')
    expect(upgradedProbe).toHaveBeenCalledOnce()
  })

  it('never writes a failed probe to the file', async () => {
    const store = storeAt()
    await store.load()
    configureVersionProbeAnswerStore(store)

    await expect(
      withVersionProbeCache(
        vi.fn(async () => undefined),
        {
          identify: identity('/opt/homebrew/bin/opencode:30:1792841234')
        }
      )('/opt/homebrew/bin/opencode')
    ).resolves.toBeUndefined()
    await store.flush()

    await expect(readFile(join(root, 'probe-answers.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
