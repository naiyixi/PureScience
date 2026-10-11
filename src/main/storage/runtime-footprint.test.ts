import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { formatBytes, formatRuntimeFootprint, measureRuntimeFootprint } from './runtime-footprint'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-footprint-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const writeSized = async (relative: string, bytes: number): Promise<void> => {
  const path = join(root, relative)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes, 7))
}

describe('runtime footprint measurement', () => {
  it('counts bytes and files per family and totals them', async () => {
    await writeSized('runtime/envs/a/file.bin', 2048)
    await writeSized('runtime/envs/a/nested/deep.bin', 1024)
    await writeSized('notebooks/session-1/run.json', 512)

    const footprint = await measureRuntimeFootprint(root, {
      families: ['runtime/envs', 'notebooks', 'claude']
    })

    expect(footprint.families).toEqual([
      { name: 'runtime/envs', bytes: 3072, files: 2, state: 'measured' },
      { name: 'notebooks', bytes: 512, files: 1, state: 'measured' },
      // A family that does not exist is NAMED, not silently reported as zero bytes.
      { name: 'claude', bytes: 0, files: 0, state: 'absent' }
    ])
    expect(footprint.measuredBytes).toBe(3584)
    expect(footprint.measuredFiles).toBe(3)
    expect(footprint.unreadable).toEqual([])
  })

  it('does not follow symlinks, so a linked tree cannot be counted twice', async () => {
    await writeSized('notebooks/real/big.bin', 4096)
    await symlink(join(root, 'notebooks', 'real'), join(root, 'notebooks', 'linked'))

    const footprint = await measureRuntimeFootprint(root, { families: ['notebooks'] })

    expect(footprint.families[0]).toMatchObject({ bytes: 4096, files: 1, state: 'measured' })
  })

  it('counts a hard-linked file once, the way du does', async () => {
    await writeSized('runtime/pkgs/pkg/file.bin', 2048)
    // The same inode, linked into an environment — micromamba's normal shape.
    await mkdir(join(root, 'runtime', 'envs'), { recursive: true })
    await link(
      join(root, 'runtime', 'pkgs', 'pkg', 'file.bin'),
      join(root, 'runtime', 'envs', 'file.bin')
    )

    const footprint = await measureRuntimeFootprint(root, {
      families: ['runtime/pkgs', 'runtime/envs']
    })

    const total = footprint.measuredBytes
    // 2048 counted once across both families, not 4096.
    expect(total).toBe(2048)
    expect(footprint.measuredFiles).toBe(1)
  })

  it('names a family it could not finish instead of reporting a partial total as complete', async () => {
    await writeSized('artifacts/p1/one.bin', 16)
    await writeSized('artifacts/p1/two.bin', 16)

    const footprint = await measureRuntimeFootprint(root, {
      families: ['artifacts'],
      maxEntries: 1
    })

    expect(footprint.families[0]).toMatchObject({ name: 'artifacts', state: 'unreadable' })
    expect(footprint.unreadable).toEqual(['artifacts'])
  })

  it('formats one greppable line, worst family first, with counts and non-measured markers', async () => {
    await writeSized('runtime/envs/e.bin', 5 * 1024 * 1024)
    await writeSized('notebooks/n.bin', 4096)

    const footprint = await measureRuntimeFootprint(root, {
      families: ['runtime/envs', 'notebooks', 'claude']
    })
    const line = formatRuntimeFootprint(footprint)

    expect(line).toBe('runtime/envs=5M/1f notebooks=4K/1f')
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(1024 ** 3 * 2.5)).toBe('2.50G')
  })

  it('keeps a zero-byte but present family visible', async () => {
    await mkdir(join(root, 'runtime', 'packs'), { recursive: true })

    const footprint = await measureRuntimeFootprint(root, { families: ['runtime/packs'] })

    expect(footprint.families[0]).toEqual({
      name: 'runtime/packs',
      bytes: 0,
      files: 0,
      state: 'measured'
    })
    expect(formatRuntimeFootprint(footprint)).toBe('runtime/packs=0B/0f')
  })
})
