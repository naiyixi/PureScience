import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'
import { load as parseYaml } from 'js-yaml'

import { isNewer } from '../../shared/update'
import type { Logger } from '../logger'

// U3 of issue #17: after an in-place install lands, the ~200 MB package electron-updater downloaded is
// dead weight — the version it carries is the one already running. This module owns that bookkeeping:
//
//   1. before handing off to the installer, `markInstallPending()` records the version being installed
//      inside electron-updater's own cache directory;
//   2. on every app launch `sweep()` compares the recorded version with the running one. Only when the
//      running version is at least the recorded one (i.e. the handoff demonstrably landed) is the cache
//      purged; otherwise the downloaded package is left untouched because it is still installable.
//
// The marker lives INSIDE the cache directory so a successful purge deletes its own evidence in one
// step, and a partial purge keeps the marker so the next launch retries — the sweep is idempotent and
// re-entrant by construction (restart, crash, or repeated launches all behave the same).
//
// Deliberate trade-off (measured, not assumed): purging removes the differential-update base too
// (`<cache>/update.zip` on macOS, `<cache>/installer.exe` on Windows). The next update therefore
// downloads in full once instead of patching; electron-updater falls back on its own ("Unable to
// locate previous update.zip for differential download (is this first install?)"). Keeping the base
// would keep a second full copy of the package on disk — exactly the 200+ MB the user reported — so
// the size win is taken and the cost is stated here rather than hidden.

export const INSTALL_MARKER_FILE = 'install-pending.json'

export type UpdateCacheLayout = {
  cacheDir: string
  pendingDir: string
  markerPath: string
}

export const updateCacheLayout = (cacheDir: string): UpdateCacheLayout => ({
  cacheDir,
  pendingDir: join(cacheDir, 'pending'),
  markerPath: join(cacheDir, INSTALL_MARKER_FILE)
})

// What `markInstallPending` writes. `version` is the version the installer was asked to install.
export type InstallMarker = { version: string; recordedAt: string }

// A file electron-updater can leave behind mid-download. Such a file is never a usable package: the
// downloaded artifact is renamed into place only after its size/sha512 check passes, and the in-flight
// file is named `temp-<name>` (DownloadedUpdateHelper.createTempUpdateFile). Anything matching this
// that survived a crash or a kill is an orphan by definition and is safe to drop.
const ORPHAN_FILE_PATTERN = /^(?:temp-|.*\.part$)/i

export type UpdateCacheSweepAction =
  | 'purged' // the install landed: every artifact for it is gone
  | 'kept-pending' // a downloaded package is still installable — left untouched
  | 'swept-orphans' // nothing installable, but a partial download's leftovers were removed
  | 'clean' // nothing to do
  | 'skipped' // the cache directory could not be resolved
  | 'purge-failed' // the purge was refused by the filesystem; retried on the next launch

export type UpdateCacheSweepOutcome = {
  action: UpdateCacheSweepAction
  cacheDir?: string
  // Evidence: what was removed and how many bytes it was, so the log (and the drills) can quantify it.
  removedFiles?: string[]
  removedBytes?: number
  orphanFiles?: string[]
  markerVersion?: string
  reason?: string
}

type CacheEntry = { name: string; bytes: number }

export type UpdateCacheDeps = {
  // Where electron-updater keeps downloaded artifacts. Injectable for tests; the default resolves the
  // installed app-update.yml, exactly like electron-updater itself (see resolveCacheDir).
  cacheDir?: string | (() => Promise<string | undefined>)
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDirectory?: () => string
  appName?: () => string | undefined
  // app-update.yml / dev-app-update.yml carrying `updaterCacheDirName`.
  configPath?: () => string | undefined
  log?: Logger
  now?: () => Date
  // Filesystem hooks, injected in tests so the sweep never touches a real disk.
  readTextFile?: (path: string) => Promise<string>
  writeTextFile?: (path: string, data: string) => Promise<void>
  makeDirectory?: (path: string) => Promise<void>
  listDirectory?: (path: string) => Promise<CacheEntry[]>
  removeDirectory?: (path: string) => Promise<void>
  removeFile?: (path: string) => Promise<void>
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Mirrors electron-updater's own base cache directory (ElectronAppAdapter.getAppCacheDir): the
// updater cache is a sibling of the OS caches, NOT under Electron's userData.
const platformCacheRoot = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string => {
  if (platform === 'win32') return env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  if (platform === 'darwin') return join(home, 'Library', 'Caches')
  return env.XDG_CACHE_HOME || join(home, '.cache')
}

// Reads `updaterCacheDirName` out of the build's update config. electron-updater puts the cache under
// `<platform cache root>/<updaterCacheDirName>`; the packaged build carries app-update.yml, dev builds
// carry dev-app-update.yml. A missing/unparseable file yields undefined, which falls back to the app
// name — the same fallback electron-updater applies when the key is absent.
const readCacheDirName = async (
  configPath: string | undefined,
  readTextFile: (path: string) => Promise<string>
): Promise<string | undefined> => {
  if (!configPath) return undefined
  try {
    const parsed: unknown = parseYaml(await readTextFile(configPath))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const name = (parsed as { updaterCacheDirName?: unknown }).updaterCacheDirName
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
  } catch {
    return undefined
  }
}

// The slice of this module the install hand-off needs: record that a version is being handed to the
// installer, and drop that claim when the handoff never started. Kept as an interface (not just the
// class) so the strategy can take either the real owner or a fake, and so a class with private state
// stays substitutable.
export type InstallMarkerWriter = {
  markInstallPending(version: string): Promise<boolean>
  clearInstallPending(): Promise<void>
}

export class UpdateCacheMaintenance implements InstallMarkerWriter {
  private readonly deps: UpdateCacheDeps
  private readonly log: Logger
  private readonly readTextFile: (path: string) => Promise<string>
  private readonly writeTextFile: (path: string, data: string) => Promise<void>
  private readonly makeDirectory: (path: string) => Promise<void>
  private readonly listDirectory: (path: string) => Promise<CacheEntry[]>
  private readonly removeDirectory: (path: string) => Promise<void>
  private readonly removeFile: (path: string) => Promise<void>
  private layoutPromise?: Promise<UpdateCacheLayout | undefined>

  constructor(deps: UpdateCacheDeps = {}) {
    this.deps = deps
    this.log = deps.log ?? NOOP_LOGGER
    this.readTextFile = deps.readTextFile ?? ((path) => readFile(path, 'utf8'))
    this.writeTextFile = deps.writeTextFile ?? ((path, data) => writeFile(path, data, 'utf8'))
    this.makeDirectory =
      deps.makeDirectory ?? ((path) => mkdir(path, { recursive: true }).then(() => {}))
    this.listDirectory = deps.listDirectory ?? listEntries
    this.removeDirectory =
      deps.removeDirectory ?? ((path) => rm(path, { recursive: true, force: true }))
    this.removeFile = deps.removeFile ?? ((path) => rm(path, { force: true }))
  }

  // Resolved once per process: the layout cannot change while the app runs, and the sweep + the
  // install marker must agree on the same directory.
  private resolveLayout(): Promise<UpdateCacheLayout | undefined> {
    this.layoutPromise ??= this.computeLayout()
    return this.layoutPromise
  }

  private async computeLayout(): Promise<UpdateCacheLayout | undefined> {
    const configured = this.deps.cacheDir
    if (typeof configured === 'function') return configured().then(maybeLayout)
    if (typeof configured === 'string') return updateCacheLayout(configured)

    let appName: string | undefined
    let configPath: string | undefined
    try {
      appName = (this.deps.appName ?? (() => app?.getName?.()))()
      configPath = (this.deps.configPath ?? defaultConfigPath)()
    } catch {
      // No Electron runtime (unit tests) — nothing to resolve.
      return undefined
    }
    const dirName = await readCacheDirName(configPath, this.readTextFile)
    const name = dirName ?? appName
    if (!name) return undefined
    const root = platformCacheRoot(
      this.deps.platform ?? process.platform,
      this.deps.env ?? process.env,
      (this.deps.homeDirectory ?? homedir)()
    )
    return updateCacheLayout(join(root, name))
  }

  async layout(): Promise<UpdateCacheLayout | undefined> {
    return this.resolveLayout()
  }

  // Records the install handoff. Best-effort by contract: a failed marker write is logged and
  // reported, never thrown, because it must not block an update the user already asked for. A missing
  // marker only costs the cleanup (the pending package is kept), never the install.
  async markInstallPending(version: string): Promise<boolean> {
    try {
      const layout = await this.resolveLayout()
      if (!layout) return false
      await this.makeDirectory(layout.cacheDir)
      const marker: InstallMarker = {
        version,
        recordedAt: (this.deps.now?.() ?? new Date()).toISOString()
      }
      await this.writeTextFile(layout.markerPath, `${JSON.stringify(marker)}\n`)
      this.log.info('update cache: recorded the pending install', {
        version,
        cacheDir: layout.cacheDir
      })
      return true
    } catch (error) {
      this.log.warn('update cache: could not record the pending install', {
        reason: errorMessage(error)
      })
      return false
    }
  }

  // Rollback of the claim above: the handoff never started, so no install is pending.
  async clearInstallPending(): Promise<void> {
    try {
      const layout = await this.resolveLayout()
      if (!layout) return
      await this.removeFile(layout.markerPath)
    } catch (error) {
      this.log.warn('update cache: could not clear the pending install marker', {
        reason: errorMessage(error)
      })
    }
  }

  async readMarker(): Promise<InstallMarker | undefined> {
    const layout = await this.resolveLayout()
    if (!layout) return undefined
    return this.readMarkerAt(layout)
  }

  private async readMarkerAt(layout: UpdateCacheLayout): Promise<InstallMarker | undefined> {
    try {
      const parsed: unknown = JSON.parse(await this.readTextFile(layout.markerPath))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      const version = (parsed as { version?: unknown }).version
      if (typeof version !== 'string' || version.trim() === '') return undefined
      const recordedAt = (parsed as { recordedAt?: unknown }).recordedAt
      return {
        version: version.trim(),
        recordedAt: typeof recordedAt === 'string' ? recordedAt : ''
      }
    } catch {
      // No marker, or an unreadable/corrupt one: treat it as "nothing is pending". That is the safe
      // direction — the sweep then only removes never-usable partial downloads.
      return undefined
    }
  }

  // The launch-time sweep. Never throws: an update cleanup must not be able to break app startup.
  async sweep(options: { currentVersion: string }): Promise<UpdateCacheSweepOutcome> {
    const layout = await this.resolveLayout().catch(() => undefined)
    if (!layout) return { action: 'skipped', reason: 'cache-unresolved' }

    const marker = await this.readMarkerAt(layout)
    if (marker && !isNewer(marker.version, options.currentVersion)) {
      // The handoff landed: the running version is at least the version the installer was asked to
      // install, so everything in this directory belongs to an update that is already in place.
      return this.purge(layout, marker)
    }

    // Nothing landed. Either the marker names a version we are not running yet (the install failed or
    // rolled back — the package is still installable, so it must NOT be touched), or there is no
    // marker at all (a download the user has not applied). Only never-usable partials are removed.
    const orphans = await this.listOrphans(layout)
    const removed: string[] = []
    for (const orphan of orphans) {
      try {
        await this.removeFile(join(layout.pendingDir, orphan.name))
        removed.push(join('pending', orphan.name))
      } catch (error) {
        this.log.warn('update cache: could not remove an orphaned partial download', {
          file: orphan.name,
          reason: errorMessage(error)
        })
      }
    }
    if (removed.length > 0) {
      this.log.info('update cache: removed orphaned partial downloads', { files: removed })
      return {
        action: 'swept-orphans',
        cacheDir: layout.cacheDir,
        orphanFiles: removed,
        ...(marker ? { markerVersion: marker.version } : {})
      }
    }
    return {
      action: marker ? 'kept-pending' : 'clean',
      cacheDir: layout.cacheDir,
      ...(marker ? { markerVersion: marker.version } : {})
    }
  }

  private async listOrphans(layout: UpdateCacheLayout): Promise<CacheEntry[]> {
    const entries = await this.listDirectory(layout.pendingDir).catch(() => [])
    return entries.filter((entry) => ORPHAN_FILE_PATTERN.test(entry.name))
  }

  // Removes the downloaded package FIRST and the marker LAST, so a filesystem refusal (a locked file on
  // Windows, a permission error) leaves the marker in place and the next launch retries the whole
  // purge. Deleting the marker first would strand the package with no record that it should be gone.
  private async purge(
    layout: UpdateCacheLayout,
    marker: InstallMarker
  ): Promise<UpdateCacheSweepOutcome> {
    const removedFiles: string[] = []
    let removedBytes = 0
    try {
      // Both listings are taken up front: the root listing carries the marker's own size, and the
      // reported byte total should account for everything the purge removed.
      const rootEntries = await this.listDirectory(layout.cacheDir).catch(() => [])
      const pendingEntries = await this.listDirectory(layout.pendingDir).catch(() => [])
      for (const entry of pendingEntries) {
        await this.removeFile(join(layout.pendingDir, entry.name))
        removedFiles.push(join('pending', entry.name))
        removedBytes += entry.bytes
      }
      await this.removeDirectory(layout.pendingDir)
      // Everything else electron-updater keeps under the cache root (the differential base
      // `update.zip`/`installer.exe`, `current.blockmap`, leftovers of an older scheme).
      for (const entry of rootEntries) {
        if (entry.name === INSTALL_MARKER_FILE) continue
        await this.removeFile(join(layout.cacheDir, entry.name))
        removedFiles.push(entry.name)
        removedBytes += entry.bytes
      }
      removedBytes += rootEntries.find((entry) => entry.name === INSTALL_MARKER_FILE)?.bytes ?? 0
      await this.removeFile(layout.markerPath)
      this.log.info('update cache: purged after a completed install', {
        cacheDir: layout.cacheDir,
        installedVersion: marker.version,
        removedFiles: removedFiles.length,
        removedBytes
      })
      return {
        action: 'purged',
        cacheDir: layout.cacheDir,
        removedFiles,
        removedBytes,
        markerVersion: marker.version
      }
    } catch (error) {
      this.log.warn('update cache: purge failed; will retry on the next launch', {
        cacheDir: layout.cacheDir,
        reason: errorMessage(error)
      })
      return {
        action: 'purge-failed',
        cacheDir: layout.cacheDir,
        removedFiles,
        removedBytes,
        markerVersion: marker.version,
        reason: errorMessage(error)
      }
    }
  }
}

const maybeLayout = (cacheDir: string | undefined): UpdateCacheLayout | undefined =>
  cacheDir ? updateCacheLayout(cacheDir) : undefined

const defaultConfigPath = (): string | undefined => {
  try {
    if (app?.isPackaged === true) return join(process.resourcesPath, 'app-update.yml')
    const appPath = app?.getAppPath?.()
    return appPath ? join(appPath, 'dev-app-update.yml') : undefined
  } catch {
    return undefined
  }
}

// One level deep is enough: electron-updater keeps the artifact in `pending/` and everything else flat
// in the cache root. Files only — a directory entry is not counted as bytes.
const listEntries = async (path: string): Promise<CacheEntry[]> => {
  const entries = await readdir(path, { withFileTypes: true })
  const files: CacheEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    files.push({ name: entry.name, bytes: await fileBytes(join(path, entry.name)) })
  }
  return files
}

const fileBytes = async (path: string): Promise<number> =>
  stat(path).then(
    (info) => info.size,
    () => 0
  )

export const createUpdateCacheMaintenance = (deps: UpdateCacheDeps = {}): UpdateCacheMaintenance =>
  new UpdateCacheMaintenance(deps)
