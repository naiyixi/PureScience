import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { measurePackageCacheRedundancy } from './usage'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pkg-cache-redundancy-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const writeSized = async (relative: string, bytes: number): Promise<string> => {
  const path = join(root, relative)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes, 5))
  return path
}

describe('package cache redundancy readout', () => {
  it('separates a cache file another link still holds from one that exists only here', async () => {
    // micromamba's real shape: the cache holds one name, an environment holds another, one inode.
    const cached = await writeSized('runtime/pkgs/pkg-a/lib.so', 2048)
    const envDir = join(root, 'runtime', 'envs', 'mine')
    await mkdir(envDir, { recursive: true })
    await link(cached, join(envDir, 'lib.so'))
    // A file only the cache names: deleting it would destroy these bytes.
    await writeSized('runtime/pkgs/pkg-b/only.bin', 1024)

    const reading = await measurePackageCacheRedundancy(root)

    expect(reading).toEqual({
      redundantBytes: 2048,
      redundantFiles: 1,
      soleLinkBytes: 1024,
      soleLinkFiles: 1,
      maxLinkCount: 2
    })
  })

  it('counts nested directories and reports an observed link count, not a claimed one', async () => {
    const cached = await writeSized('runtime/pkgs/deep/a/b/c.bin', 512)
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    await link(cached, join(root, 'elsewhere', 'c.bin'))
    await link(cached, join(root, 'elsewhere', 'c-again.bin'))

    const reading = await measurePackageCacheRedundancy(root)

    expect(reading.redundantBytes).toBe(512)
    expect(reading.maxLinkCount).toBe(3)
  })

  it('skips symlinks so a linked tree cannot be counted twice', async () => {
    await writeSized('runtime/pkgs/real/file.bin', 700)
    await symlink(join(root, 'runtime', 'pkgs', 'real'), join(root, 'runtime', 'pkgs', 'linked'))

    const reading = await measurePackageCacheRedundancy(root)

    expect(reading.soleLinkBytes).toBe(700)
    expect(reading.soleLinkFiles).toBe(1)
  })

  it('reports a measured zero when the cache does not exist, rather than failing', async () => {
    const reading = await measurePackageCacheRedundancy(root)

    expect(reading).toEqual({
      redundantBytes: 0,
      redundantFiles: 0,
      soleLinkBytes: 0,
      soleLinkFiles: 0,
      maxLinkCount: 0
    })
  })
})
