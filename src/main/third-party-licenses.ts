// Collects third-party license summaries for the Settings > About > Third-Party Licenses view.
// Reads the app's direct npm dependencies from the installed node_modules tree — the same
// dependency set that ships in the packaged app — and returns name/version plus the first lines of
// each package's LICENSE file (Apache-2.0 style files are skipped in favour of the licence text
// actually shipped with the dependency). Unreadable or license-less packages are omitted.
//
// Where the dependency tree lives (this used to be wrong): `process.cwd()` is the repository root in
// dev but is `/` for a packaged macOS app launched from Finder, so the manifest read failed there and
// the view listed nothing — while the dialog re-requested the empty result in a loop (real log: 371
// failed reads in 0.228 s from one open dialog, `main*.log` 2026-09-18). The tree always sits next to
// the app entry, so the root is resolved from the Electron app path, else by walking up from this
// module (correct in dev, and inside app.asar when packaged) — never from the current directory alone.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createLogger } from './logger'

const log = createLogger('third-party-licenses')

export type ThirdPartyLicenseEntry = {
  name: string
  version: string
  license: string
}

const LICENSE_FILE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md']
const LICENSE_PREVIEW_CHARS = 600
// Deep enough for `<root>/out/main/collector.js` in dev and `<asar>/out/main/collector.js` when
// packaged; a runaway walk is bounded so a broken layout can never turn into a filesystem crawl.
const MAX_ROOT_WALK_DEPTH = 6

// Which rule resolved the dependency root. Recorded on every run so an empty list can be told apart
// from "the tree was looked for in the wrong place" (see `rootSource` in the log lines below).
export type DependencyRootSource = 'app-path' | 'module-path' | 'cwd' | 'explicit'

export type DependencyRoot = {
  root: string
  source: DependencyRootSource
}

const isDependencyRoot = (dir: string): boolean =>
  existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules'))

// Electron's app path is the canonical answer when the collector runs inside the app; the guarded
// require keeps the module usable from a plain node process (tests, MCP child processes) where the
// electron module is either absent or not an app object.
const electronAppPath = (): string | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getAppPath?: () => string } }
    return electron.app?.getAppPath?.()
  } catch {
    return undefined
  }
}

// Pure resolution: `startDir` is the module's own directory, `appPath` the (optional) Electron app
// path. Both are injected so the three rules can be pinned in tests without a packaged build.
export const resolveDependencyRoot = (startDir: string, appPath?: string): DependencyRoot => {
  if (appPath && isDependencyRoot(appPath)) return { root: appPath, source: 'app-path' }

  let dir = startDir
  for (let depth = 0; depth < MAX_ROOT_WALK_DEPTH; depth += 1) {
    if (isDependencyRoot(dir)) return { root: dir, source: 'module-path' }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Last resort only: a tree that cannot be found from either anchor. Reported as `cwd` so the log
  // line says exactly which rule produced the root the reader is about to blame.
  return { root: process.cwd(), source: 'cwd' }
}

const readLicensePreview = async (dir: string): Promise<string | undefined> => {
  for (const candidate of LICENSE_FILE_NAMES) {
    const path = join(dir, candidate)
    if (!existsSync(path)) continue
    try {
      const content = await readFile(path, 'utf8')
      return content.slice(0, LICENSE_PREVIEW_CHARS).trim()
    } catch {
      // try the next candidate name
    }
  }
  return undefined
}

// `root` is injectable for tests and for callers that already resolved the dependency tree.
export const collectThirdPartyLicenses = async (
  options: { root?: string } = {}
): Promise<ThirdPartyLicenseEntry[]> => {
  const resolved: DependencyRoot = options.root
    ? { root: options.root, source: 'explicit' }
    : resolveDependencyRoot(__dirname, electronAppPath())

  const manifestPath = join(resolved.root, 'package.json')
  let manifest: { dependencies?: Record<string, string> } = {}
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
  } catch {
    // Self-evident failure: name the path that was read, the root it came from and which rule chose
    // it. `unable to read package.json` alone could not be told apart from an app with no deps.
    log.warn('unable to read package.json for third-party license collection', {
      path: manifestPath,
      root: resolved.root,
      rootSource: resolved.source
    })
    return []
  }

  const entries: ThirdPartyLicenseEntry[] = []
  // Counted rather than silently dropped: a view that renders fewer packages than the app ships is
  // only diagnosable if the run says how many were seen and why the rest were not listed.
  let missingPackageJson = 0
  let missingLicense = 0
  let unreadable = 0

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    try {
      const packageJsonPath = join(resolved.root, 'node_modules', name, 'package.json')
      if (!existsSync(packageJsonPath)) {
        missingPackageJson += 1
        continue
      }
      const meta = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        version?: string
        license?: string
      }
      const license = await readLicensePreview(join(resolved.root, 'node_modules', name))
      if (!license) {
        missingLicense += 1
        continue
      }
      entries.push({
        name,
        version: meta.version ?? 'unknown',
        license
      })
    } catch {
      // one bad dependency must not break the whole list
      unreadable += 1
    }
  }

  log.info('third-party licenses collected', {
    root: resolved.root,
    rootSource: resolved.source,
    dependencies: Object.keys(manifest.dependencies ?? {}).length,
    listed: entries.length,
    missingPackageJson,
    missingLicense,
    unreadable
  })

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}
