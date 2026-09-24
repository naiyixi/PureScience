import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MAIN_INSTALLATION_PENDING } from './entry-layer-archived-surfaces'

// U30 — the guard's first blind spot. U22 migrated the window onto `handoff-lifecycle:*`, a surface the
// catalog declared and the preload exposed: every source-level reading said it was installed. It was not.
// `registerHandoffLifecycleIpcHandlers` had no caller anywhere — only its own module and its unit test —
// so nothing installed those handlers and the packaged app answered `No handler registered`.
//
// What this checks: every exported IPC registrar lives in a module reachable from the main entry and is
// referenced somewhere in that reachable set (import and export statements do not count, so a registrar
// cannot cite itself into compliance).
// What it cannot check: that the reference runs at boot, or that its own caller is reached — a registrar
// invoked by a dead installer inside a live module still passes. It catches the U22 shape, which is the
// one that actually shipped a broken build.
const MAIN_ROOT = join(__dirname, '..', 'main')
const ENTRY = join(MAIN_ROOT, 'index.ts')

const toPosix = (path: string): string => path.replaceAll('\\', '/')

const collect = (root: string, collected: string[] = []): string[] => {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      collect(path, collected)
      continue
    }
    if (!/\.ts$/.test(entry) || /\.test\.ts$/.test(entry)) continue
    collected.push(path)
  }

  return collected
}

// An import or export line names a registrar without installing anything, so both are stripped before
// the reference search.
const stripWiring = (source: string): string =>
  source
    .split('\n')
    .filter(
      (line) =>
        !/^\s*import\b/.test(line) &&
        !/^\s*\}\s*from\s/.test(line) &&
        !/^\s*export\s*\{/.test(line) &&
        !/^\s*export\s+(?:const|function|async function)\s/.test(line)
    )
    .join('\n')

const resolveRelative = (fromFile: string, spec: string): string | undefined => {
  if (!spec.startsWith('.')) return undefined
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), `${base}.tsx`]) {
    if (existsSync(candidate)) return candidate
  }

  return undefined
}

// Static `from 'x'`, lazy `import('x')` and `require('x')` all put a module on the boot path: the main
// entry deliberately statically imports only lightweight modules and reaches the rest lazily.
const IMPORT_SPEC = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

const reachableFromEntry = (): Set<string> => {
  const seen = new Set<string>()
  const queue = [ENTRY]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_SPEC)) {
      const next = resolveRelative(file, match[1])
      if (next && !seen.has(next)) queue.push(next)
    }
  }

  return seen
}

// A registrar installs IPC handlers (or a runtime the app boots with); the name pattern is the
// repo-wide convention for them.
const NAME = '(?:register|install)[A-Za-z0-9_]*Ipc[A-Za-z0-9_]*'
const INLINE_EXPORT = new RegExp(`export (?:const|function|async function) (${NAME})`, 'g')
// A registrar can also be declared as a plain const and exported in a separate block (`export { f }`),
// which is exactly how the handoff-lifecycle registrar — the case this guard exists for — was written.
const BLOCK_EXPORT = new RegExp(`export \\{([^}]*)\\}`, 'g')
const BLOCK_NAME = new RegExp(`\\b(${NAME})\\b`, 'g')

const reachable = reachableFromEntry()
const files = collect(MAIN_ROOT).map((path) => ({
  path: toPosix(relative(MAIN_ROOT, path)),
  absolute: path,
  source: readFileSync(path, 'utf8')
}))

const registrars: { file: string; name: string; onBootPath: boolean }[] = []
for (const file of files) {
  const found = new Set<string>()
  for (const match of file.source.matchAll(INLINE_EXPORT)) found.add(match[1])
  for (const block of file.source.matchAll(BLOCK_EXPORT)) {
    for (const name of block[1].matchAll(BLOCK_NAME)) found.add(name[1])
  }
  for (const name of found) {
    registrars.push({ file: file.path, name, onBootPath: reachable.has(file.absolute) })
  }
}

const installed = (registrar: { name: string }): boolean => {
  const pattern = new RegExp(`\\b${registrar.name}\\b`)
  return files.some((file) => reachable.has(file.absolute) && pattern.test(stripWiring(file.source)))
}

const pending = new Set(MAIN_INSTALLATION_PENDING.map((entry) => entry.name))

describe('main-process installation', () => {
  it('leaves no exported IPC registrar without a caller on the boot path', () => {
    const orphaned = registrars
      .filter((registrar) => !pending.has(registrar.name))
      .filter((registrar) => !installed(registrar))
      .map(
        (registrar) =>
          `${registrar.name} (main/${registrar.file}${registrar.onBootPath ? '' : ', off the boot path'})`
      )

    expect(
      orphaned,
      'these registrars install IPC handlers nothing installs at boot: wire them up, or record the decision in MAIN_INSTALLATION_PENDING'
    ).toEqual([])
  })

  it('keeps the pending register honest: a registered registrar is really uninstalled', () => {
    const wired = MAIN_INSTALLATION_PENDING.filter((entry) => installed(entry)).map(
      (entry) => entry.name
    )

    expect(
      wired,
      'these registrars are installed again and must leave MAIN_INSTALLATION_PENDING'
    ).toEqual([])
  })

  it('scans a non-empty set and follows the boot graph', () => {
    // A rename that dodges the pattern, or a broken resolver, must not retire this guard quietly.
    expect(registrars.length).toBeGreaterThan(15)
    expect([...reachable].some((file) => file.endsWith(join('main', 'ipc.ts')))).toBe(true)
  })
})
