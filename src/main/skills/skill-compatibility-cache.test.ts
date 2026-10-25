// The compatibility hash decides whether materialisation skips an update, so its cache is the one place a
// performance change can silently ship stale skills. These cases pin both halves: an unchanged tree answers
// from the memo, and a content change with the same file size still invalidates it.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bundledSkillCompatibility, resetBundledSkillCompatibilityCache } from './registry'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-compat-'))
  resetBundledSkillCompatibilityCache()
  await mkdir(join(root, 'alpha'), { recursive: true })
  await writeFile(join(root, 'alpha', 'SKILL.md'), 'name: alpha\n', 'utf8')
})

afterEach(async () => {
  resetBundledSkillCompatibilityCache()
  await rm(root, { recursive: true, force: true })
})

describe('bundled skill compatibility hash', () => {
  it('answers an unchanged tree from the memo', async () => {
    const first = await bundledSkillCompatibility(root)
    const second = await bundledSkillCompatibility(root)

    expect(second).toBe(first)
  })

  it('re-hashes when a SKILL.md changes even though its size is unchanged', async () => {
    const before = await bundledSkillCompatibility(root)

    // Same byte count, different bytes: the case a directory-mtime cache would miss. The mtime is bumped
    // explicitly because the freshness key is `size:mtimeMs` and this fixture is created and rewritten
    // within the same millisecond — on the Windows lane that produced two identical keys and the memo
    // answered with the old hash (measured: the shard red on a run whose other 2,978 cases passed). The
    // rewrite still happens through the same path a rebuild would take; only the resolution dependence is
    // taken out of the case.
    const file = join(root, 'alpha', 'SKILL.md')
    await writeFile(file, 'name: alphb\n', 'utf8')
    const later = new Date(Date.now() + 1_000)
    await utimes(file, later, later)

    const after = await bundledSkillCompatibility(root)
    expect(after).not.toBe(before)
  })

  // The case above can only prove that a *detectable* stat change invalidates the memo. This one proves the
  // other half — the bytes themselves are in the hash — so a coarser timestamp can never hide a content
  // change from a cache that is asked afresh.
  it('hashes the bytes, not just the stat: a same-size rewrite still changes the value itself', async () => {
    const before = await bundledSkillCompatibility(root)
    await writeFile(join(root, 'alpha', 'SKILL.md'), 'name: alphb\n', 'utf8')
    resetBundledSkillCompatibilityCache()

    const after = await bundledSkillCompatibility(root)
    expect(after).not.toBe(before)
  })

  it('re-hashes when a new file appears', async () => {
    const before = await bundledSkillCompatibility(root)
    await writeFile(join(root, 'alpha', 'extra.md'), 'more\n', 'utf8')

    await expect(bundledSkillCompatibility(root)).resolves.not.toBe(before)
  })

  it('re-hashes when a file is deleted', async () => {
    const before = await bundledSkillCompatibility(root)
    await rm(join(root, 'alpha', 'SKILL.md'))

    await expect(bundledSkillCompatibility(root)).resolves.not.toBe(before)
  })
})
