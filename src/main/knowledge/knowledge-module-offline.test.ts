// A URL source must be searchable with no network at all, and its citation must still be checkable against the
// network. Those two requirements pull in opposite directions, so they are tested together: the copy answers the
// search, the live read answers the verifier, and the tests below prove the first never touches the second.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createKnowledgeModule, type KnowledgeModule } from './knowledge-module'

const BODY = 'Method: TP53 assay was run on 40 samples'

const urlReaderOf = (body = BODY): { read: ReturnType<typeof vi.fn> } => ({
  read: vi.fn(async (url: string) => ({ body, finalUrl: url }))
})

describe('a URL source is searched from its stored copy', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-offline-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const tempModule = (urlReader?: { read: ReturnType<typeof vi.fn> }): KnowledgeModule =>
    createKnowledgeModule({
      root,
      roots: [root],
      ...(urlReader ? { urlReader: urlReader as never } : {})
    })

  it('fetches once at registration, then answers the query from disk', async () => {
    const urlReader = urlReaderOf()
    const module = tempModule(urlReader)

    await module.register({ kind: 'url', url: 'https://example.org/paper' })
    expect(urlReader.read).toHaveBeenCalledTimes(1)

    const response = await module.search('TP53')

    expect(response.status).toBe('ok')
    expect(response.results[0]?.locator).toEqual({ kind: 'url', url: 'https://example.org/paper' })
    // The decisive reading: the search added no fetch of its own.
    expect(urlReader.read).toHaveBeenCalledTimes(1)
  })

  it('still answers after the origin becomes unreachable', async () => {
    const urlReader = urlReaderOf()
    const module = tempModule(urlReader)
    await module.register({ kind: 'url', url: 'https://example.org/paper' })

    urlReader.read.mockRejectedValue(new Error('offline'))
    const response = await module.search('TP53')

    expect(response.status).toBe('ok')
    expect(response.results[0]?.label).toBe('https://example.org/paper')
  })

  it('heals a registration that predates the copy, exactly once', async () => {
    const urlReader = urlReaderOf()
    // A source registered by an older build: the record exists, no body was stored for it.
    const { createHash } = await import('node:crypto')
    await writeFile(join(root, 'knowledge-placeholder'), '', 'utf8').catch(() => undefined)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'knowledge'), { recursive: true })
    await writeFile(
      join(root, 'knowledge', 'sources.json'),
      JSON.stringify({
        sources: [
          {
            id: 'legacy-1',
            kind: 'url',
            location: 'https://example.org/legacy',
            finalUrl: 'https://example.org/legacy',
            label: 'https://example.org/legacy',
            fingerprint: {
              algorithm: 'sha256',
              value: createHash('sha256').update(BODY, 'utf8').digest('hex'),
              bytes: Buffer.byteLength(BODY, 'utf8')
            },
            registeredAt: 1,
            updatedAt: 1
          }
        ]
      }),
      'utf8'
    )
    const module = tempModule(urlReader)

    const first = await module.search('TP53')

    expect(first.status).toBe('ok')
    expect(urlReader.read).toHaveBeenCalledTimes(1)
    // The heal is durable: the copy is on disk under the digest the source carries.
    const stored = await readdir(join(root, 'knowledge', 'contents'))
    expect(stored).toHaveLength(1)

    const second = await module.search('TP53')
    expect(second.status).toBe('ok')
    expect(urlReader.read).toHaveBeenCalledTimes(1)
  })

  it('reports a source with no copy and no reader as owed, never as "no matches"', async () => {
    const module = tempModule()
    const { createHash } = await import('node:crypto')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'knowledge'), { recursive: true })
    await writeFile(
      join(root, 'knowledge', 'sources.json'),
      JSON.stringify({
        sources: [
          {
            id: 'legacy-2',
            kind: 'url',
            location: 'https://example.org/orphan',
            label: 'orphan',
            fingerprint: {
              algorithm: 'sha256',
              value: createHash('sha256').update('gone', 'utf8').digest('hex'),
              bytes: 4
            },
            registeredAt: 1,
            updatedAt: 1
          }
        ]
      }),
      'utf8'
    )

    const response = await module.search('TP53')

    expect(response.status).toBe('not-indexed')
    expect(response.coverage).toEqual({ indexed: 0, pending: 1 })
    expect(response.results).toEqual([])
  })
})
