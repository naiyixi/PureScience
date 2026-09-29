import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  INSTALL_MARKER_FILE,
  UpdateCacheMaintenance,
  createUpdateCacheMaintenance,
  type UpdateCacheDeps
} from './cache-maintenance'

// An in-memory stand-in for the updater cache directory: files are keyed by absolute path, directories
// are implicit, and `listDirectory` mirrors the real hook (files only, one level deep). This keeps the
// purge/marker semantics testable without a disk, while the last describe block runs the same paths
// against a real filesystem.
class MemoryFs {
  readonly files = new Map<string, Buffer>()

  write(path: string, content: string | number): void {
    this.files.set(path, typeof content === 'number' ? Buffer.alloc(content) : Buffer.from(content))
  }

  text(path: string): string | undefined {
    return this.files.get(path)?.toString('utf8')
  }

  children(directory: string): string[] {
    return [...this.files.keys()]
      .filter((path) => dirname(path) === directory)
      .map((path) => basename(path))
  }

  entries(directory: string): { name: string; bytes: number }[] {
    return this.children(directory).map((name) => ({
      name,
      bytes: this.files.get(join(directory, name))?.length ?? 0
    }))
  }

  // The filesystem hooks only — cacheDir stays explicit so tests can either pin it or exercise the
  // real resolution from app-update.yml.
  hooks(): Omit<UpdateCacheDeps, 'cacheDir'> {
    return {
      readTextFile: async (path) => {
        const file = this.files.get(path)
        if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        return file.toString('utf8')
      },
      writeTextFile: async (path, data) => {
        this.write(path, data)
      },
      makeDirectory: async () => {},
      listDirectory: async (directory) => this.entries(directory),
      removeDirectory: async (directory) => {
        for (const path of [...this.files.keys()]) {
          const inside = relative(directory, path)
          if (path === directory || (!inside.startsWith('..') && !isAbsolute(inside))) {
            this.files.delete(path)
          }
        }
      },
      removeFile: async (path) => {
        this.files.delete(path)
      }
    }
  }
}

// Built with join() so the fake behaves the same on every platform (`\` on Windows).
const CACHE_DIR = join('/', 'cache', 'purescience-updater')
const layout = {
  cacheDir: CACHE_DIR,
  pendingDir: join(CACHE_DIR, 'pending'),
  markerPath: join(CACHE_DIR, INSTALL_MARKER_FILE)
}

// Seeds the layout electron-updater leaves after a real download: the artifact in `pending/`, its
// update-info.json, a stale partial from an interrupted transfer, and the differential base + blockmap
// in the cache root (macOS `update.zip`, Windows `installer.exe`).
const ARTIFACT = 'PureScience-1.70.0-arm64-mac.zip'
const TEMP_ARTIFACT = `temp-${ARTIFACT}`

const seedDownloadedCache = (fs: MemoryFs): void => {
  fs.write(join(layout.pendingDir, ARTIFACT), 4096)
  fs.write(join(layout.pendingDir, 'update-info.json'), '{"fileName":"' + ARTIFACT + '"}')
  fs.write(join(layout.pendingDir, TEMP_ARTIFACT), 512)
  fs.write(join(layout.cacheDir, 'update.zip'), 2048)
  fs.write(join(layout.cacheDir, 'current.blockmap'), 64)
}

const marker = (version: string): string =>
  JSON.stringify({ version, recordedAt: '2026-09-29T00:00:00.000Z' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UpdateCacheMaintenance.sweep', () => {
  it('purges every artifact once the recorded install has landed', async () => {
    const fs = new MemoryFs()
    seedDownloadedCache(fs)
    fs.write(layout.markerPath, marker('1.70.0'))
    const maintenance = new UpdateCacheMaintenance({ ...fs.hooks(), cacheDir: CACHE_DIR })

    const outcome = await maintenance.sweep({ currentVersion: '1.70.0' })

    expect(outcome.action).toBe('purged')
    expect(outcome.removedBytes).toBe(
      4096 +
        512 +
        2048 +
        64 +
        Buffer.byteLength('{"fileName":"' + ARTIFACT + '"}') +
        Buffer.byteLength(marker('1.70.0'))
    )
    // The downloaded package, the stale partial, the differential base and the blockmap are all gone.
    expect(fs.children(layout.pendingDir)).toEqual([])
    expect(fs.children(layout.cacheDir)).toEqual([])
    // The marker itself is gone: the purge deletes its own evidence in the same step.
    expect(fs.files.has(layout.markerPath)).toBe(false)
    expect(outcome.removedFiles).toContain(join('pending', ARTIFACT))
  })

  it('is idempotent and re-entrant: a second launch finds nothing left to purge', async () => {
    const fs = new MemoryFs()
    seedDownloadedCache(fs)
    fs.write(layout.markerPath, marker('1.70.0'))
    const first = new UpdateCacheMaintenance({ ...fs.hooks(), cacheDir: CACHE_DIR })
    await first.sweep({ currentVersion: '1.70.0' })

    // A fresh instance models the next launch (no shared state between runs).
    const second = new UpdateCacheMaintenance({ ...fs.hooks(), cacheDir: CACHE_DIR })
    const outcome = await second.sweep({ currentVersion: '1.70.0' })

    expect(outcome.action).toBe('clean')
    expect(outcome.removedFiles).toBeUndefined()
    expect(fs.files.size).toBe(0)
  })

  it('retries a purge the filesystem refused, keeping the marker as the retry record', async () => {
    const fs = new MemoryFs()
    seedDownloadedCache(fs)
    fs.write(layout.markerPath, marker('1.70.0'))
    const failing = new UpdateCacheMaintenance({
      ...{ ...fs.hooks(), cacheDir: CACHE_DIR },
      removeFile: async (path) => {
        // A locked artifact on Windows behaves exactly like this.
        if (path.endsWith('.zip') && path.includes('pending')) throw new Error('EBUSY')
        fs.files.delete(path)
      }
    })

    const refused = await failing.sweep({ currentVersion: '1.70.0' })

    expect(refused.action).toBe('purge-failed')
    expect(refused.reason).toBe('EBUSY')
    // The marker survives, so the NEXT launch (with the lock gone) finishes the job.
    expect(fs.text(layout.markerPath)).toContain('1.70.0')

    const retry = new UpdateCacheMaintenance({ ...fs.hooks(), cacheDir: CACHE_DIR })
    expect((await retry.sweep({ currentVersion: '1.70.0' })).action).toBe('purged')
    expect(fs.files.size).toBe(0)
  })

  it('never touches a package that is still installable (rollback keeps it byte-identical)', async () => {
    const fs = new MemoryFs()
    seedDownloadedCache(fs)
    const artifact = join(layout.pendingDir, ARTIFACT)
    const before = fs.files.get(artifact)
    // The handoff was recorded but the app came back on the OLD version: the install failed or rolled
    // back, so the downloaded package is exactly what the user needs for another attempt.
    fs.write(layout.markerPath, marker('1.70.0'))

    const outcome = await new UpdateCacheMaintenance({ ...fs.hooks(), cacheDir: CACHE_DIR }).sweep({
      currentVersion: '1.69.0'
    })

    expect(outcome.action).toBe('swept-orphans')
    expect(fs.files.get(artifact)).toEqual(before)
    expect(fs.text(layout.markerPath)).toContain('1.70.0')
    // The differential base is not reusable for the NEXT update either... but it belongs to the pending
    // install, so it stays until that install lands.
    expect(fs.files.has(join(layout.cacheDir, 'update.zip'))).toBe(true)
    expect(fs.children(layout.pendingDir)).toEqual([ARTIFACT, 'update-info.json'])
  })

  it('removes a cancelled download’s leftovers but keeps a downloaded package with no marker', async () => {
    const fs = new MemoryFs()
    seedDownloadedCache(fs)

    const outcome = await new UpdateCacheMaintenance({ ...fs.hooks(), cacheDir: CACHE_DIR }).sweep({
      currentVersion: '1.69.0'
    })

    // No marker: the user downloaded but has not applied yet, so the artifact must stay installable…
    expect(outcome.action).toBe('swept-orphans')
    expect(outcome.orphanFiles).toEqual([join('pending', TEMP_ARTIFACT)])
    expect(fs.children(layout.pendingDir)).toEqual([ARTIFACT, 'update-info.json'])
    // …while a `temp-` partial (or a `.part` fragment) is never usable and goes.
    fs.write(join(layout.pendingDir, 'legacy.zip.part'), 32)
    const second = await new UpdateCacheMaintenance({ ...fs.hooks(), cacheDir: CACHE_DIR }).sweep({
      currentVersion: '1.69.0'
    })
    expect(second.orphanFiles).toEqual([join('pending', 'legacy.zip.part')])
  })

  it('treats a corrupt marker as "nothing pending" instead of guessing', async () => {
    const fs = new MemoryFs()
    seedDownloadedCache(fs)
    fs.write(layout.markerPath, 'not json at all')

    const outcome = await new UpdateCacheMaintenance({ ...fs.hooks(), cacheDir: CACHE_DIR }).sweep({
      currentVersion: '1.70.0'
    })

    expect(outcome.action).toBe('swept-orphans')
    expect(fs.files.has(join(layout.pendingDir, ARTIFACT))).toBe(true)
  })

  it('skips cleanly when the cache directory cannot be resolved', async () => {
    const maintenance = new UpdateCacheMaintenance({
      cacheDir: async () => undefined,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })

    await expect(maintenance.sweep({ currentVersion: '1.70.0' })).resolves.toEqual({
      action: 'skipped',
      reason: 'cache-unresolved'
    })
  })

  it('resolves the layout from the app cache root + updaterCacheDirName in app-update.yml', async () => {
    const fs = new MemoryFs()
    fs.write(
      '/app/app-update.yml',
      'provider: generic\nurl: https://example.invalid\nupdaterCacheDirName: purescience-updater\n'
    )
    const maintenance = new UpdateCacheMaintenance({
      ...fs.hooks(),
      platform: 'darwin',
      homeDirectory: () => '/Users/researcher',
      appName: () => 'PureScience',
      configPath: () => '/app/app-update.yml',
      env: {}
    })

    await expect(maintenance.layout()).resolves.toEqual({
      cacheDir: '/Users/researcher/Library/Caches/purescience-updater',
      pendingDir: '/Users/researcher/Library/Caches/purescience-updater/pending',
      markerPath: `/Users/researcher/Library/Caches/purescience-updater/${INSTALL_MARKER_FILE}`
    })
  })

  it('falls back to the app name when app-update.yml carries no cache dir name', async () => {
    const maintenance = new UpdateCacheMaintenance({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\researcher\\AppData\\Local' },
      homeDirectory: () => 'C:\\Users\\researcher',
      appName: () => 'PureScience',
      configPath: () => '/missing/app-update.yml',
      readTextFile: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
    })

    await expect(maintenance.layout()).resolves.toEqual({
      cacheDir: join('C:\\Users\\researcher\\AppData\\Local', 'PureScience'),
      pendingDir: join('C:\\Users\\researcher\\AppData\\Local', 'PureScience', 'pending'),
      markerPath: join('C:\\Users\\researcher\\AppData\\Local', 'PureScience', INSTALL_MARKER_FILE)
    })
  })
})

describe('UpdateCacheMaintenance marker', () => {
  it('records the pending install and drops it on request', async () => {
    const fs = new MemoryFs()
    const maintenance = new UpdateCacheMaintenance({ ...fs.hooks(), cacheDir: CACHE_DIR })

    await expect(maintenance.markInstallPending('1.70.0')).resolves.toBe(true)
    expect(JSON.parse(fs.text(layout.markerPath) ?? '{}')).toEqual({
      version: '1.70.0',
      recordedAt: expect.any(String)
    })

    await maintenance.clearInstallPending()
    expect(fs.files.has(layout.markerPath)).toBe(false)
    // Idempotent: clearing an absent marker is not an error.
    await expect(maintenance.clearInstallPending()).resolves.toBeUndefined()
  })

  it('is best-effort: a refused write reports failure without throwing', async () => {
    const warn = vi.fn()
    const maintenance = new UpdateCacheMaintenance({
      cacheDir: CACHE_DIR,
      makeDirectory: async () => {},
      writeTextFile: async () => {
        throw new Error('EROFS')
      },
      log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }
    })

    await expect(maintenance.markInstallPending('1.70.0')).resolves.toBe(false)
    expect(warn).toHaveBeenCalledWith('update cache: could not record the pending install', {
      reason: 'EROFS'
    })
  })
})

describe('UpdateCacheMaintenance over a real filesystem', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('writes the marker and purges a real cache directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'purescience-update-cache-'))
    const cacheDir = join(root, 'purescience-updater')
    await mkdir(join(cacheDir, 'pending'), { recursive: true })
    await writeFile(join(cacheDir, 'pending', 'update.zip'), Buffer.alloc(64 * 1024))
    await writeFile(join(cacheDir, 'pending', 'temp-update.zip'), Buffer.alloc(128))
    await writeFile(join(cacheDir, 'update.zip'), Buffer.alloc(32 * 1024))
    await writeFile(join(cacheDir, 'current.blockmap'), 'blocks')

    const maintenance = createUpdateCacheMaintenance({ cacheDir, now: () => new Date(0) })
    await expect(maintenance.markInstallPending('1.70.0')).resolves.toBe(true)
    const markerBytes = (await stat(join(cacheDir, INSTALL_MARKER_FILE))).size
    await expect(readdir(cacheDir)).resolves.toEqual(
      expect.arrayContaining([INSTALL_MARKER_FILE, 'pending', 'update.zip', 'current.blockmap'])
    )

    const outcome = await maintenance.sweep({ currentVersion: '1.70.0' })

    expect(outcome.action).toBe('purged')
    expect(outcome.removedBytes).toBe(64 * 1024 + 128 + 32 * 1024 + 'blocks'.length + markerBytes)
    // The directory itself stays behind, empty: nothing to download-again, and nothing to re-install
    // from — which is the acceptance wording ("0 bytes / no package").
    await expect(readdir(cacheDir)).resolves.toEqual([])
  })
})
