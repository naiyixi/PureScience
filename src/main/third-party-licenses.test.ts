import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { collectThirdPartyLicenses, resolveDependencyRoot } from './third-party-licenses'

// Both halves of the packaged-app failure are pinned here: WHERE the dependency tree is looked for
// (process.cwd() is `/` for a bundle launched from Finder) and WHAT the collector reports when it
// cannot read the manifest. Fixtures are real directories on disk so the resolver walks the same way
// it does in dev and inside app.asar, not through a mocked filesystem.

let sandbox: string

const write = async (path: string, content: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

const makeDependency = async (
  root: string,
  name: string,
  options: { version?: string; license?: string } = {}
): Promise<void> => {
  await write(
    join(root, 'node_modules', name, 'package.json'),
    JSON.stringify({ name, version: options.version ?? '1.0.0' })
  )
  if (options.license !== undefined) {
    await write(join(root, 'node_modules', name, 'LICENSE'), options.license)
  }
}

// A root that looks like an installed app: package.json + node_modules side by side.
const makeAppRoot = async (root: string, dependencies: string[]): Promise<void> => {
  await write(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture-app',
      dependencies: Object.fromEntries(dependencies.map((d) => [d, '1.0.0']))
    })
  )
  await mkdir(join(root, 'node_modules'), { recursive: true })
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'ps-licenses-'))
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

describe('resolveDependencyRoot', () => {
  it('prefers the Electron app path when it carries the dependency tree', async () => {
    const appRoot = join(sandbox, 'packaged', 'app.asar')
    const moduleDir = join(sandbox, 'packaged', 'app.asar', 'out', 'main')
    await makeAppRoot(appRoot, ['alpha'])

    expect(resolveDependencyRoot(moduleDir, appRoot)).toEqual({ root: appRoot, source: 'app-path' })
  })

  it('walks up from the module when the app path is missing or is not a dependency root', async () => {
    const appRoot = join(sandbox, 'repo')
    const moduleDir = join(appRoot, 'out', 'main')
    await makeAppRoot(appRoot, ['alpha'])

    expect(resolveDependencyRoot(moduleDir)).toEqual({ root: appRoot, source: 'module-path' })
    // An app path without node_modules beside its package.json is not a dependency tree — a walk from
    // the module still finds the real one (this is the packaged-then-relocated shape).
    expect(resolveDependencyRoot(moduleDir, join(sandbox, 'packaged'))).toEqual({
      root: appRoot,
      source: 'module-path'
    })
  })

  it('falls back to the current directory only when neither anchor resolves', async () => {
    // Precondition, asserted rather than assumed: the walk from a bare temp dir must not pass through
    // a directory that itself looks like an app root (`/` is where the walk stops).
    expect(existsSync(join('/', 'package.json'))).toBe(false)

    const deep = join(sandbox, 'not-an-app', 'a', 'b')
    await mkdir(deep, { recursive: true })

    expect(resolveDependencyRoot(deep, join(sandbox, 'also-not-an-app'))).toEqual({
      root: process.cwd(),
      source: 'cwd'
    })
  })
})

describe('collectThirdPartyLicenses', () => {
  it('lists dependencies that ship a license and counts the ones it skips', async () => {
    const root = join(sandbox, 'app')
    await makeAppRoot(root, ['zod', 'no-license', 'not-installed'])
    await makeDependency(root, 'zod', {
      version: '4.1.0',
      license: 'MIT License\n\nCopyright (c) 2026'
    })
    await makeDependency(root, 'no-license', { version: '2.0.0' })

    const entries = await collectThirdPartyLicenses({ root })

    expect(entries).toEqual([
      { name: 'zod', version: '4.1.0', license: 'MIT License\n\nCopyright (c) 2026' }
    ])
  })

  it('trims a licence preview and sorts by name', async () => {
    const root = join(sandbox, 'app')
    await makeAppRoot(root, ['beta', 'alpha'])
    await makeDependency(root, 'beta', { version: '2.0.0', license: 'B'.repeat(900) })
    await makeDependency(root, 'alpha', { version: '1.0.0', license: 'A' })

    const entries = await collectThirdPartyLicenses({ root })

    expect(entries.map((entry) => entry.name)).toEqual(['alpha', 'beta'])
    expect(entries[1].license).toHaveLength(600)
  })

  it('reads the manifest from the injected root, not from the process directory', async () => {
    const root = join(sandbox, 'elsewhere')
    await makeAppRoot(root, ['alpha'])
    await makeDependency(root, 'alpha', { version: '9.9.9', license: 'MIT' })

    // The process directory is the repository, which declares a different dependency set entirely.
    expect(process.cwd()).not.toBe(root)
    expect(await collectThirdPartyLicenses({ root })).toEqual([
      { name: 'alpha', version: '9.9.9', license: 'MIT' }
    ])
  })

  it('returns an empty list instead of throwing when the manifest is unreadable', async () => {
    expect(await collectThirdPartyLicenses({ root: join(sandbox, 'missing') })).toEqual([])
  })

  it("lists this repository's own dependencies from its real node_modules tree", async () => {
    // The collector is the app's own function, pointed at the real tree it ships — the same call the
    // Settings view makes in dev. CI installs node_modules, so this reads real packages everywhere.
    const repoRoot = resolve(__dirname, '..', '..')
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }

    const entries = await collectThirdPartyLicenses({ root: repoRoot })

    expect(Object.keys(manifest.dependencies).length).toBeGreaterThan(0)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.version).not.toHaveLength(0)
      expect(entry.license.trim().length).toBeGreaterThan(0)
    }
    expect(entries.map((entry) => entry.name)).toEqual(
      [...entries.map((entry) => entry.name)].sort()
    )
  })
})
