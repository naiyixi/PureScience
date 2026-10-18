// The sweep's own record. Two distinctions matter here and neither is cosmetic:
//   * "never swept" (no record) is not "swept and found nothing" (a record with zeros);
//   * a record that will not parse is "we cannot say", so it is dropped rather than read as zeros.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KnowledgeRepository } from './knowledge-repository'

describe('the last sweep record', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-sweep-record-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const repository = (): KnowledgeRepository =>
    new KnowledgeRepository({
      root,
      roots: [root],
      urlReader: { read: async (url: string) => ({ body: 'a page', finalUrl: url }) }
    })

  it('is absent before the first sweep — not a zeroed record', async () => {
    const overview = await repository().overview()
    expect(overview.lastSweep).toBeUndefined()
  })

  it('records what the sweep actually did, and the overview carries it', async () => {
    const store = repository()
    await store.register({ kind: 'url', url: 'https://example.org/kept' })
    await store.sweepContents()

    const overview = await store.overview()
    expect(overview.lastSweep).toMatchObject({ scanned: 1, kept: 1, removed: 0, failed: 0 })
    expect(typeof overview.lastSweep?.at).toBe('string')
    // The timestamp parses — a record that says "swept at <garbage>" is worse than no record.
    expect(Number.isNaN(Date.parse(overview.lastSweep?.at ?? ''))).toBe(false)
  })

  it('counts removals in the record with the same numbers the sweep returned', async () => {
    const store = repository()
    const { createHash } = await import('node:crypto')
    const orphan = createHash('sha256').update('old bytes').digest('hex')
    const { writeFile: write, mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'knowledge', 'contents'), { recursive: true })
    await write(join(root, 'knowledge', 'contents', orphan), 'old bytes', 'utf8')

    const outcome = await store.sweepContents()
    const overview = await store.overview()

    expect(outcome.removed).toEqual([orphan])
    expect(overview.lastSweep).toMatchObject({ removed: 1, failed: 0 })
    expect(overview.lastSweep?.bytesFreed).toBe(outcome.bytesFreed)
  })

  it('drops an unreadable record instead of reporting zeros as fact', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'knowledge'), { recursive: true })
    await writeFile(join(root, 'knowledge', 'last-sweep.json'), '{ not json', 'utf8')

    const overview = await repository().overview()

    expect(overview.lastSweep).toBeUndefined()
    // Sanity: the file really sits where the reader looks, so the absence above is the parser's verdict.
    expect(await readFile(join(root, 'knowledge', 'last-sweep.json'), 'utf8')).toContain('not json')
  })
})
