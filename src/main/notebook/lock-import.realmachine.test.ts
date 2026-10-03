import { execFileSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { micromambaSpawnEnv } from './micromamba'
import { DEFAULT_MAX_CACHE_RELATIVE_PATH, selectMicromambaCache } from './micromamba-cache'
import {
  DefaultRuntimeProvisioner,
  ImportLockIncompleteError,
  type ProvisionerDeps
} from './provisioner'
import { runMicromamba, verifyExecutable } from './provisioner-runtime'
import { pkgsCache } from './runtime-paths'

// A7 REAL-MACHINE acceptance: the real micromamba binary, a REAL @EXPLICIT lock and its real tarballs,
// an isolated runtime root under the scratch dir, and a REAL environment build — then the created
// interpreter is executed. This is deliberately not a mocked test: the lock's per-package md5 is
// verified against real archives and `micromamba create --offline` hard-links them.
//
// Why the fixtures come from the app's curated pack: this machine's download caches only retain a
// PARTIAL set of the interpreter closure (76 of 350 archives for the default env), so the pack
// directory is the one place with a complete, checksum-consistent archive set for a python env. The
// import path under test only consumes the lock TEXT the caller passes, so an external lock exercises
// exactly this code.
//
// Self-skipping: a machine without the fixtures (CI runners) skips, so this never turns into a red
// build for lacking a local pack.
const REAL_RUNTIME_ROOT = join(homedir(), '.purescience', 'runtime')
const MICROMAMBA = join(REAL_RUNTIME_ROOT, 'micromamba', 'bin', 'micromamba')
const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
const PACK_DIR = join(REAL_RUNTIME_ROOT, 'packs', '1', PACK_SUBDIR, 'python-3.12')
const PACK_LOCK = join(PACK_DIR, 'python-3.12.lock')
const hasFixtures = existsSync(MICROMAMBA) && existsSync(PACK_LOCK)

const fileNameOf = (lockLine: string): string => {
  const url = lockLine.split('#')[0]
  return url.slice(url.lastIndexOf('/') + 1)
}

// Places a hard link per lock entry into the isolated root's flat pkgs cache — the same layout the
// app's own offline pack seeding produces. `skip` leaves one entry out to exercise the missing case.
const seedCacheFromPack = (root: string, lockText: string, skip?: string): void => {
  const cache = pkgsCache(root)
  mkdirSync(cache, { recursive: true })
  for (const raw of lockText.split('\n')) {
    const line = raw.trim()
    if (!/^https?:\/\//.test(line)) continue
    const file = fileNameOf(line)
    if (skip && file === skip) continue
    linkSync(join(PACK_DIR, file), join(cache, file))
  }
}

const makeRealDeps = (root: string): ProvisionerDeps => ({
  root,
  mm: MICROMAMBA,
  channel: 'conda-forge',
  fetchBundle: async () => undefined,
  runArgv: (argv, signal, onChild, onBeforeSpawn, runCache, maxCacheRelativePath) =>
    runMicromamba(
      argv,
      micromambaSpawnEnv(
        root,
        undefined,
        {
          selectCache: () =>
            runCache ??
            selectMicromambaCache(root, maxCacheRelativePath ?? DEFAULT_MAX_CACHE_RELATIVE_PATH)
        },
        maxCacheRelativePath ?? DEFAULT_MAX_CACHE_RELATIVE_PATH
      ),
      signal,
      onChild,
      onBeforeSpawn
    ),
  verify: (bin, prefix) => verifyExecutable(bin, { prefix })
})

describe.skipIf(!hasFixtures)(
  'A7 external-lock import · real machine (real micromamba + real tarballs)',
  () => {
    it('offline-imports a real lock, matching it package-for-package, and the built interpreter runs', async () => {
      const root = mkdtempSync(join(tmpdir(), 'a7-real-'))
      try {
        const lock = readFileSync(PACK_LOCK, 'utf8')
        const expected = lock.split('\n').filter((line) => /^https?:\/\//.test(line.trim())).length
        seedCacheFromPack(root, lock)
        const provisioner = new DefaultRuntimeProvisioner(makeRealDeps(root))

        const outcome = await provisioner.createNamedEnvironmentFromLock(
          'lock-import-env',
          'python',
          lock,
          { allowDownload: false }
        )

        // Every entry came from the local cache — zero downloads means zero network bytes.
        expect(outcome.coverage).toEqual({
          total: expected,
          fromCache: expected,
          downloaded: 0,
          missing: []
        })
        const prefix = join(root, 'envs', 'lock-import-env')
        const bin = join(prefix, 'bin', 'python')
        expect(existsSync(bin)).toBe(true)

        // The environment equals the lock: micromamba records one conda-meta entry per installed package.
        const installed = readdirSync(join(prefix, 'conda-meta')).filter((f) => f.endsWith('.json'))
        console.log(`[a7-real] lock entries=${expected} conda-meta records=${installed.length}`)
        expect(installed.length).toBeGreaterThanOrEqual(expected)

        // Real execution: the interpreter the import built reports the version the lock pinned.
        const printed = execFileSync(
          bin,
          ['-c', 'import json,sys; print(json.dumps(list(sys.version_info[:3])))'],
          { encoding: 'utf8' }
        ).trim()
        console.log(`[a7-real] interpreter version=${printed}`)
        expect(JSON.parse(printed)).toEqual([3, 12, 13])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 300_000)

    it('refuses the whole lock when one archive md5 disagrees, and creates nothing', async () => {
      const root = mkdtempSync(join(tmpdir(), 'a7-real-badmd5-'))
      try {
        const lock = readFileSync(PACK_LOCK, 'utf8')
        const lines = lock.split('\n')
        const target = lines.findIndex((line) => /^https?:\/\//.test(line.trim()))
        const targetFile = fileNameOf(lines[target])
        // Flip the published md5 of one real entry — a lock whose checksum cannot be honoured.
        const [url] = lines[target].split('#')
        lines[target] = `${url}#${'0'.repeat(32)}`
        const corrupted = lines.join('\n')
        seedCacheFromPack(root, lock)
        const provisioner = new DefaultRuntimeProvisioner(makeRealDeps(root))

        const error = await provisioner
          .createNamedEnvironmentFromLock('bad-md5-env', 'python', corrupted, {
            allowDownload: false
          })
          .then(() => undefined)
          .catch((e: unknown) => e)

        expect(error).toBeInstanceOf(ImportLockIncompleteError)
        const coverage = (error as ImportLockIncompleteError).coverage
        expect(coverage.missing).toHaveLength(1)
        expect(coverage.missing[0].file).toBe(targetFile)
        // The cached copy is present but cannot honour the lock's md5 → the reason says exactly that
        // (never "not in the cache"), and the entry is discarded rather than reused.
        expect(coverage.missing[0].reason).toContain('cached copy does not match the md5')
        // Fail-closed: no prefix at all, and the poisoned cache entry was discarded.
        expect(existsSync(join(root, 'envs', 'bad-md5-env'))).toBe(false)
        expect(existsSync(join(pkgsCache(root), targetFile))).toBe(false)
        console.log(
          `[a7-real] bad-md5 refusal: file=${targetFile} reason=${coverage.missing[0].reason}`
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 300_000)

    it('names every absent archive in an offline import instead of building a smaller environment', async () => {
      const root = mkdtempSync(join(tmpdir(), 'a7-real-missing-'))
      try {
        const lock = readFileSync(PACK_LOCK, 'utf8')
        const omitted = fileNameOf(
          lock.split('\n').find((line) => /^https?:\/\//.test(line.trim()))!
        )
        seedCacheFromPack(root, lock, omitted)
        const provisioner = new DefaultRuntimeProvisioner(makeRealDeps(root))

        const error = await provisioner
          .createNamedEnvironmentFromLock('missing-env', 'python', lock, { allowDownload: false })
          .then(() => undefined)
          .catch((e: unknown) => e)

        expect(error).toBeInstanceOf(ImportLockIncompleteError)
        const coverage = (error as ImportLockIncompleteError).coverage
        expect(coverage.missing).toHaveLength(1)
        expect(coverage.missing[0].file).toBe(omitted)
        expect(coverage.missing[0].reason).toContain('Not in the local cache')
        expect(existsSync(join(root, 'envs', 'missing-env'))).toBe(false)
        console.log(
          `[a7-real] offline missing: file=${omitted} reason=${coverage.missing[0].reason}`
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 300_000)
  }
)
