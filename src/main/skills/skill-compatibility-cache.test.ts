// The compatibility hash decides whether materialisation skips an update, so its cache is the one place a
// performance change can silently ship stale skills. These cases pin both halves: an unchanged tree answers
// from the memo, and a content change with the same file size still invalidates it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

    // Same byte count, different bytes: the case a directory-mtime cache would miss.
    await writeFile(join(root, 'alpha', 'SKILL.md'), 'name: alphb\n', 'utf8')

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
