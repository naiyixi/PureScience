// Copies of fetched bodies are named by their own digest, so a copy no source names any more can never answer a
// search. The sweep exists for the two ways such a copy appears: a register that wrote the bytes and then died
// before committing the row, and a deletion that failed when its source was removed.
//
// The case worth the most care is the one where the register cannot be read at all: an unreadable record and a
// record with no sources produce the same directory listing, and reading the second into it deletes every copy
// on the disk. So that case is a named refusal, and the test asserts the bytes are still there afterwards.

import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KnowledgeRepository } from './knowledge-repository'

const digestOf = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')

describe('sweeping orphan copies', () => {
  let root: string
  let repository: KnowledgeRepository
  let body = 'referenced body'
  const reader = {
    read: async (url: string) => ({ body, finalUrl: url })
  }

  beforeEach(async () => {
    body = 'referenced body'
    root = await mkdtemp(join(tmpdir(), 'knowledge-sweep-'))
    repository = new KnowledgeRepository({ root, roots: [root], urlReader: reader })
  })

  afterEach(async () => {
    await chmod(join(root, 'knowledge', 'contents'), 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  const contentsDir = (): string => join(root, 'knowledge', 'contents')
  const contents = async (): Promise<string[]> => {
    try {
      return (await readdir(contentsDir())).sort()
    } catch {
      return []
    }
  }
  const writeOrphan = async (text: string): Promise<string> => {
    await mkdir(contentsDir(), { recursive: true })
    const digest = digestOf(text)
    await writeFile(join(contentsDir(), digest), text, 'utf8')
    return digest
  }

  it('deletes the copies no source names, keeps the named one, and reports the bytes it freed', async () => {
    await repository.register({ kind: 'url', url: 'https://example.org/kept' })
    const orphan = await writeOrphan('nobody references this')

    const sweep = await repository.sweepContents()

    expect(sweep.removed).toEqual([orphan])
    expect(sweep.failed).toEqual([])
    expect(sweep.kept).toBe(1)
    expect(sweep.bytesFreed).toBe(Buffer.byteLength('nobody references this', 'utf8'))
    expect(await contents()).toEqual([digestOf('referenced body')])
    // Every entry is accounted for in exactly one bucket — a sweep that cannot say where an entry went must not
    // be able to look like it did.
    expect(sweep.scanned).toBe(
      sweep.kept +
        sweep.removed.length +
        sweep.mismatched.length +
        sweep.failed.length +
        sweep.ignored
    )
  })

  it('deletes a copy whose bytes no longer match its name, and reports it apart from the orphans', async () => {
    await repository.register({ kind: 'url', url: 'https://example.org/kept' })
    // The registered copy's name, filled with different bytes: what an in-place edit or a restore from another
    // machine leaves behind. The source still names it, so a name-only sweep would count it as `kept`.
    const tampered = digestOf('referenced body')
    await writeFile(join(contentsDir(), tampered), 'some other body entirely', 'utf8')

    const sweep = await repository.sweepContents()

    expect(sweep.mismatched).toEqual([tampered])
    expect(sweep.removed).toEqual([])
    expect(sweep.kept).toBe(0)
    expect(sweep.bytesFreed).toBe(Buffer.byteLength('some other body entirely', 'utf8'))
    // Gone from the store: a copy that is not the bytes its name claims cannot answer truthfully, and leaving it
    // would keep a search quoting text the source's fingerprint never covered.
    expect(await contents()).toEqual([])
    expect(
      sweep.kept +
        sweep.removed.length +
        sweep.mismatched.length +
        sweep.failed.length +
        sweep.ignored
    ).toBe(sweep.scanned)
    // The reading survives this process: the note says one copy was not what it claimed, so a person reading the
    // panel tomorrow learns the store was edited, not that housekeeping ran clean.
    const record = JSON.parse(
      await readFile(join(root, 'knowledge', 'last-sweep.json'), 'utf8')
    ) as { removed: number; mismatched?: number }
    expect(record.mismatched).toBe(1)
    expect(record.removed).toBe(0)
  })

  it('refuses by name when the register cannot be read, and deletes nothing', async () => {
    const orphan = await writeOrphan('still here afterwards')
    await mkdir(join(root, 'knowledge'), { recursive: true })
    await writeFile(join(root, 'knowledge', 'sources.json'), '{ not json', 'utf8')

    await expect(repository.sweepContents()).rejects.toMatchObject({ code: 'record-unreadable' })

    // The refusal is only worth anything if the bytes survived it.
    expect(await contents()).toEqual([orphan])
  })

  it('treats a copy store that was never created as nothing to sweep', async () => {
    const sweep = await repository.sweepContents()

    expect(sweep).toEqual({
      scanned: 0,
      kept: 0,
      removed: [],
      mismatched: [],
      failed: [],
      bytesFreed: 0,
      ignored: 0
    })
  })

  it('leaves entries that are not digest-named copies alone, and counts them', async () => {
    await mkdir(join(contentsDir(), 'a-folder'), { recursive: true })
    await writeFile(join(contentsDir(), 'notes.txt'), 'someone left this here', 'utf8')

    const sweep = await repository.sweepContents()

    expect(sweep.removed).toEqual([])
    expect(sweep.ignored).toBe(2)
    expect(await contents()).toEqual(['a-folder', 'notes.txt'])
  })

  // POSIX only: deleting a file is a write on its directory, and Windows does not model that permission the same
  // way. The behaviour under test — "could not delete" is named, not counted as freed — is platform-independent.
  it.runIf(process.platform !== 'win32')(
    'reports a copy it could not delete by name instead of counting it as freed',
    async () => {
      const stuck = await writeOrphan('read-only directory')
      await chmod(contentsDir(), 0o555)

      const sweep = await repository.sweepContents()

      expect(sweep.removed).toEqual([])
      expect(sweep.failed).toEqual([stuck])
      expect(sweep.bytesFreed).toBe(0)
      await chmod(contentsDir(), 0o755)
      expect(await contents()).toEqual([stuck])
    }
  )
})
