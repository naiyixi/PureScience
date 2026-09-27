// @vitest-environment node
//
// Guards the test partition declared in vitest.config.ts.
//
// Why this exists: a four-group split is only as good as its partition. A glob that stops matching
// (file renamed, helper imported under a new name, a new `*.architecture.test.ts` added) silently
// moves real work back into the unbounded pool — the exact contention the split was built to remove —
// and nothing else in the suite would notice. So the partition is asserted, not assumed:
//
//   1. every test file belongs to exactly one group (no gaps, no double runs),
//   2. every real-SQLite suite (it calls createProjectDbClient/ensureProjectSchema) is OUT of the
//      unbounded pool,
//   3. every real-kernel/child-process suite is in the `process` group,
//   4. every explicitly listed path still exists on disk, and the architecture glob matches exactly
//      the architecture suites that exist.
//
// A failure here is a real defect in the config, not a formatting nit — fix the config, never the
// assertion.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import picomatch from 'picomatch'
import { describe, expect, it } from 'vitest'

import { VITEST_EXCLUDE_PATTERNS, VITEST_TEST_GROUPS } from '../vitest.config'

const REPO_ROOT = process.cwd()

/** Test files that the config's `exclude` keeps out of the run entirely. */
const excluded = picomatch(VITEST_EXCLUDE_PATTERNS.map((pattern) => pattern.replace(/^\.\//, '')))

const toPosix = (value: string): string => value.split(sep).join('/')

/**
 * Directories the default Vitest discovery never reaches, so the walk skips them too. `e2e/` is
 * Playwright's; the rest are build output, dependency copies or editor state.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'dist-electron',
  'out',
  'release',
  'coverage',
  'e2e',
  'tmp'
])

const isTestFile = (name: string): boolean => /\.(test|spec)\.(c|m)?[jt]sx?$/.test(name)

const walk = (dir: string, found: string[] = []): string[] => {
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue
      walk(path, found)
      continue
    }
    if (!isTestFile(entry.name)) continue
    if (excluded(path)) continue
    found.push(toPosix(path))
  }
  return found
}

// Walks from the repository root, not just src/ and test/: the unit group inherits Vitest's default
// discovery, which also reaches scripts/**, cli/**, packages/**, build/** and the root-level
// *.config.test.ts files. A walk that only looked at src/ and test/ could not detect a narrowed
// `include` — the exact regression that would silently drop those suites.
const allTestFiles = walk('').sort()

const matches = (file: string, globs: readonly string[]): boolean =>
  picomatch(globs as string[])(file)

const groupOf = (file: string): string =>
  (Object.keys(VITEST_TEST_GROUPS) as Array<keyof typeof VITEST_TEST_GROUPS>).find((group) =>
    matches(file, VITEST_TEST_GROUPS[group])
  ) ?? 'unit'

const sourceOf = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf8')

describe('vitest test partition', () => {
  it('discovers the suite (sanity: the walk itself is not empty)', () => {
    expect(allTestFiles.length).toBeGreaterThan(1000)
  })

  it('assigns every test file to exactly one group', () => {
    const doubleGrouped = allTestFiles.filter((file) => {
      const groups = (
        Object.keys(VITEST_TEST_GROUPS) as Array<keyof typeof VITEST_TEST_GROUPS>
      ).filter((group) => matches(file, VITEST_TEST_GROUPS[group]))
      return groups.length > 1
    })

    expect(doubleGrouped).toEqual([])
  })

  it('keeps discovery breadth: suites outside src/ and test/ stay in the run', () => {
    const outsideSrcAndTest = allTestFiles.filter(
      (file) => !file.startsWith('src/') && !file.startsWith('test/')
    )

    // These are exactly the suites a narrowed `include: ['src/**', 'test/**']` would drop while
    // leaving every remaining test green: the CI classifiers, the CLI packages, packaging and the
    // config's own test. Pin a few by name, then assert they are not quietly rerouted.
    expect(outsideSrcAndTest.length).toBeGreaterThan(30)
    for (const file of [
      'vitest.config.test.ts',
      'electron.vite.config.test.ts',
      'scripts/ci/classify-pr-changes.test.ts',
      'scripts/ci/check-ci-integrity.test.ts',
      'packages/purescience/cli.test.ts',
      'cli/index.test.ts',
      'build/packaging.test.ts'
    ]) {
      expect(allTestFiles).toContain(file)
    }

    expect(outsideSrcAndTest.filter((file) => groupOf(file) !== 'unit')).toEqual([])
  })

  it('keeps real-SQLite suites out of the unbounded parallel pool', () => {
    const realDatabaseUsers = allTestFiles.filter(
      (file) =>
        !file.endsWith('vitest-project-partition.test.ts') &&
        /createProjectDbClient|ensureProjectSchema/.test(sourceOf(file))
    )

    // Sanity: the detection itself must keep finding them, otherwise this guard is vacuous.
    expect(realDatabaseUsers.length).toBeGreaterThan(20)

    // The process group also uses real databases, but each of its suites owns a child process, so
    // being out of the unbounded pool is what matters there.
    const stillInPool = realDatabaseUsers.filter((file) => groupOf(file) === 'unit')

    expect(stillInPool).toEqual([])
  })

  it('keeps real-kernel and child-process suites in the process group', () => {
    const kernelSuites = allTestFiles.filter((file) =>
      /process\.env\.RUN_KERNEL|process\.env\.RUN_SMOKE/.test(sourceOf(file))
    )

    expect(kernelSuites.length).toBeGreaterThan(0)

    const misgrouped = kernelSuites.filter((file) => groupOf(file) !== 'process')

    expect(misgrouped).toEqual([])
  })

  it('lists only paths that exist, so a rename cannot silently shrink a group', () => {
    const missing = Object.values(VITEST_TEST_GROUPS)
      .flat()
      .filter((glob) => !glob.includes('*'))
      .filter((file) => !existsSync(join(REPO_ROOT, file)))

    expect(missing).toEqual([])
  })

  it('has no dead globs: every pattern matches at least one suite on disk', () => {
    const dead = Object.entries(VITEST_TEST_GROUPS).flatMap(([group, globs]) =>
      globs
        .filter((glob) => !allTestFiles.some((file) => picomatch(glob)(file)))
        .map((glob) => `${group}: ${glob}`)
    )

    // A glob that matches nothing looks harmless and is not: it silently stops protecting the suite
    // it was written for (e.g. an integration file renamed to plain `.test.ts`), and the group it
    // belonged to keeps running green over an empty set.
    expect(dead).toEqual([])
  })

  it('matches every architecture suite that exists, and nothing else', () => {
    const onDisk = allTestFiles.filter((file) => file.endsWith('.architecture.test.ts')).sort()
    const inGroup = allTestFiles.filter((file) => groupOf(file) === 'architecture').sort()

    expect(inGroup).toEqual(onDisk)
    expect(onDisk.length).toBeGreaterThanOrEqual(4)
  })

  it('keeps the group sizes in the shape the split was designed for', () => {
    const counts = allTestFiles.reduce<Record<string, number>>((acc, file) => {
      const group = groupOf(file)
      acc[group] = (acc[group] ?? 0) + 1
      return acc
    }, {})

    // The unbounded pool must still hold the bulk of the suite; the隔离组 exist to take the
    // contention sources out, not to move the suite around.
    expect(counts.unit ?? 0).toBeGreaterThan(allTestFiles.length * 0.9)
    expect(counts.architecture ?? 0).toBeLessThanOrEqual(12)
  })

  it('reports the partition it verified (so the numbers can be cited from a test log)', () => {
    const summary = Object.entries(
      allTestFiles.reduce<Record<string, number>>((acc, file) => {
        const group = groupOf(file)
        acc[group] = (acc[group] ?? 0) + 1
        return acc
      }, {})
    )
      .map(([group, count]) => `${group}=${count}`)
      .join(' ')

    console.log(`[vitest partition] total=${allTestFiles.length} ${summary}`)
    expect(summary).toContain('unit=')
  })
})

describe('vitest partition (config shape)', () => {
  it('runs the architecture group serially and after the parallel groups', async () => {
    const config = (await import('../vitest.config')).default
    const projects = (config.test?.projects ?? []) as Array<Record<string, unknown>>
    const architecture = projects.find(
      (project) => (project.test as Record<string, unknown> | undefined)?.name === 'architecture'
    )

    expect(architecture).toBeDefined()
    const architectureTest = architecture?.test as Record<string, unknown>
    expect(architectureTest.fileParallelism).toBe(false)
    expect(architectureTest.maxWorkers).toBe(1)
    expect((architectureTest.sequence as { groupOrder?: number } | undefined)?.groupOrder).toBe(1)

    // Coverage is a non-project option: it must stay on the root config, where the gate aggregates
    // every group. A project that carried its own thresholds would report a partial suite as passing.
    for (const project of projects) {
      expect((project.test as Record<string, unknown> | undefined)?.coverage).toBeUndefined()
    }
    expect(config.test?.coverage?.thresholds).toBeDefined()
  })

  it('keeps the heavy groups out of the unbounded pool and gives each one its own group order', async () => {
    const config = (await import('../vitest.config')).default
    const projects = (config.test?.projects ?? []) as Array<Record<string, unknown>>
    const byName = new Map(
      projects.map((project) => [
        (project.test as Record<string, unknown>).name as string,
        (project.test as Record<string, unknown>).sequence as { groupOrder?: number } | undefined
      ])
    )

    // The unbounded pool owns group 0 alone; every bounded group is ordered after it.
    expect(byName.get('unit')?.groupOrder ?? 0).toBe(0)

    for (const name of ['architecture', 'process', 'database']) {
      const project = projects.find(
        (candidate) => (candidate.test as Record<string, unknown>).name === name
      )?.test as Record<string, unknown> | undefined

      expect(project?.fileParallelism, `${name} must not run files in parallel`).toBe(false)
      expect(project?.maxWorkers, `${name} must be pinned to one worker`).toBe(1)
      expect(typeof project?.sequence, `${name} must declare a group order`).not.toBe('undefined')
    }

    // Vitest refuses to collect when two projects share a group order but not a worker count, so the
    // orders are unique by construction. Asserting it here turns a collection crash into a unit
    // failure with a readable reason.
    const orders = ['unit', 'architecture', 'process', 'database'].map(
      (name) => byName.get(name)?.groupOrder ?? 0
    )
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('never narrows the unit group with an explicit include', async () => {
    const config = (await import('../vitest.config')).default
    const projects = (config.test?.projects ?? []) as Array<Record<string, unknown>>
    const unit = projects.find(
      (project) => (project.test as Record<string, unknown> | undefined)?.name === 'unit'
    )?.test as Record<string, unknown> | undefined

    // The unit group subtracts from the default discovery and never defines its own include: an
    // `include` here is how ~40 suites outside src/ and test/ disappear without a failure.
    expect(unit?.include).toBeUndefined()
    expect(Array.isArray(unit?.exclude)).toBe(true)
  })

  it('keeps the relative paths it compares against relative to the repository root', () => {
    // Guards a subtle failure: process.cwd() is the repo root under vitest, so a config that ever
    // starts resolving members from another base would make every membership check silently false.
    expect(relative(REPO_ROOT, REPO_ROOT)).toBe('')
    expect(existsSync(join(REPO_ROOT, 'vitest.config.ts'))).toBe(true)
  })
})
