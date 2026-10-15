import { describe, expect, it, vi } from 'vitest'

import type { KnowledgeSource } from '../../shared/knowledge'
import { sha256Of } from './knowledge-citation'
import { createKnowledgeWikiGenerator } from './knowledge-wiki'

const source = (location: string, label: string, folder: string): KnowledgeSource => ({
  id: label,
  kind: 'file',
  location,
  label,
  folder,
  fingerprint: { algorithm: 'sha256', value: 'stored-but-never-trusted', bytes: 0 },
  registeredAt: 1,
  updatedAt: 1
})

const FOLDER = '/managed'
const A = source('/managed/a.md', 'a.md', FOLDER)
const B = source('/managed/b.md', 'b.md', FOLDER)

// Determinism is the whole contract: same folder + same bytes ⇒ same document, so a regenerated wiki is
// diffable and a line's citation can be recomputed by anyone.
describe('folder wiki', () => {
  it('writes a line per file, each citing the file and the digest of its CURRENT bytes', async () => {
    const generator = createKnowledgeWikiGenerator({
      reader: { read: async (path) => (path === A.location ? 'alpha' : 'beta') }
    })

    const result = await generator.render(FOLDER, [A, B])

    expect(result.state).toBe('written')
    if (result.state !== 'written') return
    expect(result.entries).toBe(2)
    // The digest is recomputed from the bytes, not taken from the stored fingerprint.
    expect(result.content).toContain(sha256Of('alpha'))
    expect(result.content).not.toContain('stored-but-never-trusted')
    expect(result.content).toContain('| 5 |')
  })

  it('is byte-identical on regeneration, and does not depend on input order', async () => {
    const generator = createKnowledgeWikiGenerator({
      reader: { read: async (path) => (path === A.location ? 'alpha' : 'beta') }
    })

    const first = await generator.render(FOLDER, [A, B])
    const second = await generator.render(FOLDER, [A, B])
    const reordered = await generator.render(FOLDER, [B, A])

    expect(first).toEqual(second)
    expect(reordered).toEqual(first)
    // No timestamp anywhere: a document with one could never be byte-identical twice.
    if (first.state === 'written') {
      expect(first.content).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })

  it('names an empty folder and an unreadable file instead of writing a half-cited document', async () => {
    const generator = createKnowledgeWikiGenerator({ reader: { read: async () => undefined } })

    expect(await generator.render(FOLDER, [])).toEqual({ state: 'empty-folder' })
    expect(await generator.render(FOLDER, [A])).toEqual({ state: 'unreadable-folder' })
  })

  it('re-reads on every generation rather than caching the first answer', async () => {
    const body = vi.fn(async () => 'alpha')
    const generator = createKnowledgeWikiGenerator({ reader: { read: body } })

    await generator.render(FOLDER, [A])
    await generator.render(FOLDER, [A])

    expect(body).toHaveBeenCalledTimes(2)
  })
})
