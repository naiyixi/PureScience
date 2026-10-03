import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import {
  DefaultRuntimeProvisioner,
  ImportLockIncompleteError,
  type ProvisionProgress,
  type ProvisionerDeps
} from './provisioner'
import { envPrefix, pkgsCache, pythonBin, rBin } from './runtime-paths'

// A7 external-lock import: the main-process capability. Every case here is fail-closed — a lock entry
// that cannot be proven against its published md5 never reaches an environment prefix, and the
// coverage report names each unsatisfied entry instead of quietly installing a smaller env.

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-lock-'))
const md5Of = (data: string): string => createHash('md5').update(data).digest('hex')
const pkgUrl = (file: string): string => `https://conda.example.org/conda-forge/${file}`
const lockFor = (entries: Array<{ url: string; md5: string }>): string =>
  ['@EXPLICIT', ...entries.map((entry) => `${entry.url}#${entry.md5}`)].join('\n') + '\n'

type LockDeps = {
  deps: ProvisionerDeps
  argvs: string[][]
  /** The staged lock file as the (fake) micromamba saw it: path, whether it existed, its text. */
  staged: Array<{ path: string; existed: boolean; text: string }>
}

const makeLockDeps = (
  root: string,
  language: NotebookLanguage,
  overrides: Partial<ProvisionerDeps> = {}
): LockDeps => {
  const argvs: string[][] = []
  const staged: LockDeps['staged'] = []
  const deps: ProvisionerDeps = {
    root,
    mm: '/mm',
    channel: 'conda-forge',
    fetchBundle: async () => undefined,
    runArgv: async (argv) => {
      argvs.push(argv)
      const idx = argv.findIndex((a) => a === '--prefix' || a === '-p')
      const prefix = argv[idx + 1]
      // createFromLockArgv reads the staged lock through --file; record what micromamba would see so
      // the test can prove the lock was on disk DURING the create (and gone afterwards).
      const fileIdx = argv.indexOf('--file')
      if (fileIdx >= 0) {
        const path = argv[fileIdx + 1]
        staged.push({
          path,
          existed: existsSync(path),
          text: existsSync(path) ? readFileSync(path, 'utf8') : ''
        })
      }
      const bin = language === 'python' ? pythonBin(prefix) : rBin(prefix)
      mkdirSync(join(bin, '..'), { recursive: true })
      writeFileSync(bin, 'x')
    },
    verify: async () => undefined,
    ...overrides
  }
  return { deps, argvs, staged }
}

const seedCache = (root: string, file: string, data: string): void => {
  mkdirSync(pkgsCache(root), { recursive: true })
  writeFileSync(join(pkgsCache(root), file), data)
}

describe('DefaultRuntimeProvisioner.createNamedEnvironmentFromLock (A7)', () => {
  it('reuses cache-hit tarballs, reports 0 downloads, and creates the prefix OFFLINE from the lock', async () => {
    const root = makeRoot()
    const data = 'cached-tarball-bytes'
    const file = 'zlib-1.3.1-h1.tar.bz2'
    seedCache(root, file, data)
    const lock = lockFor([{ url: pkgUrl(file), md5: md5Of(data) }])
    const { deps, argvs, staged } = makeLockDeps(root, 'python')
    const provisioner = new DefaultRuntimeProvisioner(deps)

    const outcome = await provisioner.createNamedEnvironmentFromLock('lock-env', 'python', lock, {
      allowDownload: false
    })

    expect(outcome.coverage).toEqual({ total: 1, fromCache: 1, downloaded: 0, missing: [] })
    expect(outcome.environment).toMatchObject({
      name: 'lock-env',
      language: 'python',
      ready: true,
      isDefault: false
    })
    // Exactly one micromamba call, and it is the offline lock create (not an online solve).
    expect(argvs).toHaveLength(1)
    const argv = argvs[0]
    expect(argv).toContain('create')
    expect(argv).toContain('--offline')
    expect(argv.indexOf('--file')).toBeGreaterThan(-1)
    expect(argv[argv.indexOf('-p') + 1]).toBe(envPrefix(root, 'lock-env'))
    // The lock was readable by micromamba during the create…
    expect(staged).toHaveLength(1)
    expect(staged[0].existed).toBe(true)
    expect(staged[0].text).toBe(lock)
    // …and the staging file is cleaned up afterwards (dir may remain, no .lock left behind).
    expect(readdirSync(join(root, 'locks'))).toEqual([])
  })

  it('downloads a missing tarball, keeps it only after its md5 verifies, and counts it as downloaded', async () => {
    const root = makeRoot()
    const data = 'fresh-bytes'
    const file = 'pkg-a-1.0-0.tar.bz2'
    const lock = lockFor([{ url: pkgUrl(file), md5: md5Of(data) }])
    const { deps, argvs } = makeLockDeps(root, 'python', {
      downloadPackage: async (url, destination) => {
        expect(url).toBe(pkgUrl(file))
        writeFileSync(destination, data)
      }
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)

    const outcome = await provisioner.createNamedEnvironmentFromLock('dl-env', 'python', lock)

    expect(outcome.coverage).toEqual({ total: 1, fromCache: 0, downloaded: 1, missing: [] })
    expect(readFileSync(join(pkgsCache(root), file), 'utf8')).toBe(data)
    expect(argvs).toHaveLength(1)
  })

  it('rejects a downloaded tarball whose md5 disagrees with the lock, deleting it and naming the entry', async () => {
    const root = makeRoot()
    const file = 'pkg-b-2.0-1.tar.bz2'
    const lock = lockFor([{ url: pkgUrl(file), md5: md5Of('expected-bytes') }])
    const { deps, argvs } = makeLockDeps(root, 'python', {
      downloadPackage: async (_url, destination) => writeFileSync(destination, 'tampered-bytes')
    })
    const provisioner = new DefaultRuntimeProvisioner(deps)

    const error = await provisioner
      .createNamedEnvironmentFromLock('bad-env', 'python', lock)
      .then(() => undefined)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ImportLockIncompleteError)
    const coverage = (error as ImportLockIncompleteError).coverage
    expect(coverage.total).toBe(1)
    expect(coverage.downloaded).toBe(0)
    expect(coverage.missing).toEqual([
      { file, reason: expect.stringContaining('md5 mismatch') as unknown as string }
    ])
    // The tampered file was discarded, and no prefix was created.
    expect(existsSync(join(pkgsCache(root), file))).toBe(false)
    expect(existsSync(envPrefix(root, 'bad-env'))).toBe(false)
    expect(argvs).toHaveLength(0)
  })

  it('with downloads disabled, names the missing entry and never calls the downloader or creates a prefix', async () => {
    const root = makeRoot()
    const file = 'pkg-c-3.0-0.tar.bz2'
    const lock = lockFor([{ url: pkgUrl(file), md5: md5Of('x') }])
    const downloadPackage = vi.fn(async () => undefined)
    const { deps, argvs } = makeLockDeps(root, 'python', { downloadPackage })
    const provisioner = new DefaultRuntimeProvisioner(deps)

    const error = await provisioner
      .createNamedEnvironmentFromLock('offline-env', 'python', lock, { allowDownload: false })
      .then(() => undefined)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ImportLockIncompleteError)
    expect((error as ImportLockIncompleteError).coverage).toEqual({
      total: 1,
      fromCache: 0,
      downloaded: 0,
      missing: [
        { file, reason: expect.stringContaining('downloads are disabled') as unknown as string }
      ]
    })
    expect(downloadPackage).not.toHaveBeenCalled()
    expect(argvs).toHaveLength(0)
    expect(existsSync(envPrefix(root, 'offline-env'))).toBe(false)
  })

  it('treats a cache entry whose md5 does not match as a VERIFICATION FAILURE and REMOVES it (no silent reuse)', async () => {
    const root = makeRoot()
    const file = 'pkg-d-4.0-0.tar.bz2'
    seedCache(root, file, 'poisoned-bytes')
    const lock = lockFor([{ url: pkgUrl(file), md5: md5Of('real-bytes') }])
    const { deps } = makeLockDeps(root, 'python')
    const provisioner = new DefaultRuntimeProvisioner(deps)

    const error = await provisioner
      .createNamedEnvironmentFromLock('poisoned-env', 'python', lock, { allowDownload: false })
      .then(() => undefined)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ImportLockIncompleteError)
    // The cached copy FAILED verification, which is a different fact from "not in the cache" — the
    // reason must say so (a real-machine run caught the report blurring the two).
    expect((error as ImportLockIncompleteError).coverage.missing).toEqual([
      {
        file,
        reason: expect.stringContaining('cached copy does not match the md5') as unknown as string
      }
    ])
    expect(existsSync(join(pkgsCache(root), file))).toBe(false)
  })

  it('rejects the WHOLE lock when any entry carries no valid md5 (no download, no prefix)', async () => {
    const root = makeRoot()
    const file = 'pkg-e-5.0-0.tar.bz2'
    const downloadPackage = vi.fn(async () => undefined)
    const { deps, argvs } = makeLockDeps(root, 'python', { downloadPackage })
    const provisioner = new DefaultRuntimeProvisioner(deps)

    await expect(
      provisioner.createNamedEnvironmentFromLock(
        'malformed-env',
        'python',
        `@EXPLICIT\n${pkgUrl(file)}\n`
      )
    ).rejects.toThrow(/malformed package entry/)
    await expect(
      provisioner.createNamedEnvironmentFromLock('empty-env', 'python', '@EXPLICIT\n')
    ).rejects.toThrow(/no package entries/)

    expect(downloadPackage).not.toHaveBeenCalled()
    expect(argvs).toHaveLength(0)
  })

  it('builds an R environment when the language is "r" (R interpreter is what gets verified)', async () => {
    const root = makeRoot()
    const data = 'r-tarball'
    const file = 'r-base-4.4-0.tar.bz2'
    seedCache(root, file, data)
    const lock = lockFor([{ url: pkgUrl(file), md5: md5Of(data) }])
    const { deps } = makeLockDeps(root, 'r')
    const provisioner = new DefaultRuntimeProvisioner(deps)

    const outcome = await provisioner.createNamedEnvironmentFromLock('r-lock-env', 'r', lock, {
      allowDownload: false
    })

    expect(outcome.environment).toMatchObject({ name: 'r-lock-env', language: 'r', ready: true })
    expect(existsSync(rBin(envPrefix(root, 'r-lock-env')))).toBe(true)
  })

  it('refuses an over-budget prefix on Windows before touching the cache', async () => {
    const root = makeRoot()
    const longName = `env-${'x'.repeat(140)}`
    const downloadPackage = vi.fn(async () => undefined)
    const { deps, argvs } = makeLockDeps(root, 'python', { platform: 'win32', downloadPackage })
    const provisioner = new DefaultRuntimeProvisioner(deps)
    const lock = lockFor([{ url: pkgUrl('pkg-f.tar.bz2'), md5: md5Of('f') }])

    await expect(
      provisioner.createNamedEnvironmentFromLock(longName, 'python', lock, { allowDownload: false })
    ).rejects.toThrow(/Windows environment path budget/)
    expect(downloadPackage).not.toHaveBeenCalled()
    expect(argvs).toHaveLength(0)
  })

  it('emits per-entry import progress tagged with the language', async () => {
    const root = makeRoot()
    const a = 'a-bytes'
    const b = 'b-bytes'
    seedCache(root, 'pkg-a.tar.bz2', a)
    seedCache(root, 'pkg-b.tar.bz2', b)
    const lock = lockFor([
      { url: pkgUrl('pkg-a.tar.bz2'), md5: md5Of(a) },
      { url: pkgUrl('pkg-b.tar.bz2'), md5: md5Of(b) }
    ])
    const { deps } = makeLockDeps(root, 'python')
    const provisioner = new DefaultRuntimeProvisioner(deps)

    const events: ProvisionProgress[] = []
    await provisioner.createNamedEnvironmentFromLock('progress-env', 'python', lock, {
      allowDownload: false,
      onProgress: (p) => events.push(p)
    })

    expect(events).toHaveLength(2)
    expect(events.map((e) => e.progress)).toEqual([0.5, 1])
    for (const event of events) {
      expect(event.phase).toBe('import-lock')
      expect(event.language).toBe('python')
      expect(event.message).not.toBe('')
    }
  })
})
