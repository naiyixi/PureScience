// Collects third-party license summaries for the Settings > About > Third-Party Licenses view.
// Reads the app's direct npm dependencies from the installed node_modules tree — the same
// dependency set that ships in the packaged app — and returns name/version plus the first lines of
// each package's LICENSE file (Apache-2.0 style files are skipped in favour of the licence text
// actually shipped with the dependency). Unreadable or license-less packages are omitted.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createLogger } from './logger'

const log = createLogger('third-party-licenses')

export type ThirdPartyLicenseEntry = {
  name: string
  version: string
  license: string
}

const LICENSE_FILE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md']
const LICENSE_PREVIEW_CHARS = 600

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

export const collectThirdPartyLicenses = async (): Promise<ThirdPartyLicenseEntry[]> => {
  const manifestPath = join(process.cwd(), 'package.json')
  let manifest: { dependencies?: Record<string, string> } = {}
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
  } catch {
    log.warn('unable to read package.json for third-party license collection')
    return []
  }

  const entries: ThirdPartyLicenseEntry[] = []
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    try {
      const packageJsonPath = join(process.cwd(), 'node_modules', name, 'package.json')
      if (!existsSync(packageJsonPath)) continue
      const meta = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        version?: string
        license?: string
      }
      const license = await readLicensePreview(join(process.cwd(), 'node_modules', name))
      if (!license) continue
      entries.push({
        name,
        version: meta.version ?? 'unknown',
        license
      })
    } catch {
      // one bad dependency must not break the whole list
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}
