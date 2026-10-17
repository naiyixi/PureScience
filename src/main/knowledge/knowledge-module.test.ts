// The chain end to end, on a real temporary store: registration writes a fingerprint, a query reads
// the bytes at query time, and the citation's digest is recomputed from the matched line. This is the
// first test that exercises the knowledge layer the way a caller will — not each part in isolation.

import { createHash } from 'node:crypto'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKnowledgeModule, type KnowledgeModule } from './knowledge-module'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

describe('knowledge module', () => {
  let root: string
  let module: KnowledgeModule

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ps-knowledge-'))
    module = createKnowledgeModule({ root, roots: [root] })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('registers a file, then cites the matched line from its own bytes', async () => {
    const path = join(root, 'notes.md')
    await writeFile(path, ['first line', 'the matched line', 'last line'].join('\n'), 'utf8')
    const registered = await module.register({ kind: 'file', path })
    expect(registered).toHaveLength(1)
    expect(registered[0]?.fingerprint.bytes).toBeGreaterThan(0)

    const response = await module.search('matched')

    expect(response.status).toBe('ok')
    expect(response.mode).toBe('lexical')
    expect(response.degradation).toBe('semantic-source-unconfigured')
    expect(response.results).toHaveLength(1)
    expect(response.results[0]?.matchedBy).toBe('lexical')
    expect(response.results[0]?.locator).toEqual({
      kind: 'file',
      path,
      startLine: 2,
      endLine: 2
    })
    // The digest is of the line as read now — not of the file, and not taken from the store.
    expect(response.results[0]?.sha256).toBe(sha256('the matched line'))
  })

  it('counts a source it cannot search as pending instead of reporting no matches', async () => {
    const withUrl = createKnowledgeModule({
      root,
      roots: [root],
      urlReader: {
        read: async (url: string) => ({ body: `body of ${url}`, finalUrl: url })
      }
    })
    await withUrl.register({ kind: 'url', url: 'https://example.org/doc' })

    // A module with no URL reader cannot read that source: it must say so in coverage.
    const response = await module.search('body')

    expect(response.results).toHaveLength(0)
    expect(response.coverage.pending).toBe(1)
    // No hits + work outstanding is `not-indexed`, never `no-matches`.
    expect(response.status).toBe('not-indexed')
  })

  it('reports a source that disappeared as unreadable, not as absent', async () => {
    const path = join(root, 'gone.md')
    await writeFile(path, 'searchable text here', 'utf8')
    await module.register({ kind: 'file', path })
    await unlink(path)

    const response = await module.search('searchable')

    expect(response.results).toHaveLength(0)
    expect(response.coverage).toEqual({ indexed: 0, pending: 1 })
    expect(response.status).toBe('not-indexed')
  })

  it('passes a semantic port through, so the module reports hybrid once one is configured', async () => {
    const path = join(root, 'notes.md')
    await writeFile(path, 'the matched line', 'utf8')
    await module.register({ kind: 'file', path })
    // The semantic source must name the same source id, or fusion would treat it as a different span.
    const sourceId = (await module.list())[0]?.id ?? 'missing'

    const hybrid = createKnowledgeModule({
      root,
      roots: [root],
      semantic: {
        query: async () => ({
          hits: [
            {
              sourceId,
              label: 'notes.md',
              text: 'the matched line',
              locator: { kind: 'file', path, startLine: 1, endLine: 1 },
              score: 0.9
            }
          ],
          model: 'embed-small',
          dimensions: 768
        })
      }
    })

    const response = await hybrid.search('matched')

    expect(response.mode).toBe('hybrid')
    expect(response.degradation).toBeUndefined()
    expect(response.results[0]?.matchedBy).toBe('both')
  })
})
