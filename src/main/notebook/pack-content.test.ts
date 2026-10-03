import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { micromambaCacheLockKey } from './micromamba-cache'
import { lockEntries, lockPackages, validateAndSeedPack } from './pack-content'
import { withSharedCacheLock } from './pkgs-cache-lock'
import { pkgsCache } from './runtime-paths'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))
const hexMd5 = 'a'.repeat(32)

// lockEntries is the URL-preserving parse the external-lock import (A7) uses; lockPackages is the
// name+md5 view the pack seeder uses. Both must reject the WHOLE lock on a single bad entry — a
// checksum-less line is unverifiable, and "unverifiable" must never degrade into "installed anyway".
describe('lockEntries', () => {
  it('keeps each entry URL alongside its basename and md5, ignoring the header and blanks', () => {
    const entries = lockEntries(
      [
        '@EXPLICIT',
        '',
        `https://conda.example.org/conda-forge/zlib-1.3.1-h1.tar.bz2#${hexMd5}`,
        '  '
      ].join('\n')
    )

    expect(entries).toEqual([
      {
        url: 'https://conda.example.org/conda-forge/zlib-1.3.1-h1.tar.bz2',
        file: 'zlib-1.3.1-h1.tar.bz2',
        md5: hexMd5
      }
    ])
  })

  it('rejects a lock with no package entries at all', () => {
    expect(() => lockEntries('@EXPLICIT\n\n')).toThrow(/no package entries/)
  })

  it('rejects the whole lock when one entry has no md5 fragment', () => {
    expect(() =>
      lockEntries(
        [
          `https://conda.example.org/conda-forge/ok-1.0-0.tar.bz2#${hexMd5}`,
          'https://conda.example.org/conda-forge/unverifiable-1.0-0.tar.bz2'
        ].join('\n')
      )
    ).toThrow(/malformed package entry/)
  })

  it('rejects an md5 that is not 32 hex characters', () => {
    expect(() =>
      lockEntries('https://conda.example.org/conda-forge/short-1.0-0.tar.bz2#deadbeef')
    ).toThrow(/malformed package entry/)
  })
})

describe('lockPackages', () => {
  it('projects the entries to file + md5 only (the pack-seeding view)', () => {
    expect(lockPackages(`https://conda.example.org/conda-forge/x-1.0-0.tar.bz2#${hexMd5}`)).toEqual(
      [{ file: 'x-1.0-0.tar.bz2', md5: hexMd5 }]
    )
  })
})

describe('validateAndSeedPack', () => {
  it('waits for users of the physical legacy cache before publishing a tarball', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-pack-seed-lock-'))
    const packDir = join(root, 'pack')
    const packageFile = 'package-1.0-0.conda'
    const packageBytes = 'verified package bytes'
    const md5 = createHash('md5').update(packageBytes).digest('hex')
    const lockPath = join(packDir, 'python-3.12.lock')
    const destination = join(pkgsCache(root), packageFile)
    mkdirSync(packDir, { recursive: true })
    writeFileSync(lockPath, `@EXPLICIT\nhttps://host/win-64/${packageFile}#${md5}\n`, {
      flag: 'wx'
    })
    writeFileSync(join(packDir, packageFile), packageBytes)

    const key = micromambaCacheLockKey(pkgsCache(root))
    let releaseReader!: () => void
    let readerEntered!: () => void
    const release = new Promise<void>((resolve) => {
      releaseReader = resolve
    })
    const entered = new Promise<void>((resolve) => {
      readerEntered = resolve
    })
    const reader = withSharedCacheLock(key, async () => {
      readerEntered()
      await release
    })
    await entered

    const seed = validateAndSeedPack(root, packDir, lockPath)
    await tick()
    expect(existsSync(destination)).toBe(false)

    releaseReader()
    await Promise.all([reader, seed])
    await expect(readFile(destination, 'utf8')).resolves.toBe(packageBytes)
  })
})
