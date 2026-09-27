import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  WINDOWS_TEST_MODULE_GROUPS,
  WINDOWS_TEST_SHARD_COUNT,
  windowsTestShard
} from './windows-test-sequencer'

const REPO_ROOT = process.cwd()
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'dist-electron',
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
    if (isTestFile(entry.name)) found.push(path.split(sep).join('/'))
  }
  return found
}

const testFiles = walk('')

describe('Windows module-aware sharding', () => {
  it.each([
    ['src/renderer/src/pages/workspace/WorkspacePage.test.tsx', 1],
    ['src/renderer/src/pages/settings/SettingsPage.test.tsx', 2],
    ['src/renderer/src/stores/session-store.test.ts', 2],
    ['src/renderer/src/components/Button.test.tsx', 2],
    ['src/main/notebook/runtime-service.test.ts', 3],
    ['src/main/settings/service.test.ts', 4],
    ['src/main/storage/data-migration.test.ts', 4],
    ['src/main/session-package/service.test.ts', 4],
    ['src/main/acp/runtime.test.ts', 5],
    ['src/main/agents/handoff-lifecycle.test.ts', 5],
    ['src/main/connectors/registry.test.ts', 6],
    ['src/main/references/collections.test.ts', 6],
    ['src/main/artifacts/provenance-repository.test.ts', 7],
    ['src/main/reviewer/repository.test.ts', 7],
    ['src/main/compute/compute-service.test.ts', 7],
    ['src/shared/bookmark.test.ts', 8],
    ['scripts/ci/classify-pr-changes.test.ts', 8],
    ['packages/purescience/cli.test.ts', 8],
    ['vitest.config.test.ts', 8],
    ['src/main/new-module/new.test.ts', 8]
  ])('routes %s to shard %i on either path separator', (path, shard) => {
    expect(windowsTestShard(path)).toBe(shard)
    expect(windowsTestShard(path.split('/').join('\\'))).toBe(shard)
  })

  it('keeps new tests reachable: the last shard owns everything unnamed', () => {
    // A directory nobody has classified yet must still run somewhere, or adding a module would
    // silently stop testing it on Windows.
    expect(windowsTestShard('src/main/brand-new-module/thing.test.ts')).toBe(
      WINDOWS_TEST_SHARD_COUNT
    )
    expect(windowsTestShard('docs-adjacent/new.test.ts')).toBe(WINDOWS_TEST_SHARD_COUNT)
  })

  it('resolves nested prefixes by order, never by accident', () => {
    // Nesting itself is legitimate (e.g. `src/renderer/src/pages/` contains
    // `src/renderer/src/pages/workspace/`), because shard lookup is first-match-wins. What must never
    // happen is a nested pair whose ORDER does not resolve it — that would silently route files to
    // whichever prefix happened to be written first.
    const flat = WINDOWS_TEST_MODULE_GROUPS.flat() as readonly string[]

    for (const [index, prefix] of flat.entries()) {
      const containers = flat.filter((other) => other !== prefix && prefix.startsWith(other))

      for (const container of containers) {
        expect(
          flat.indexOf(container),
          `"${prefix}" is nested in "${container}" but listed after it, so "${container}" would win`
        ).toBeGreaterThan(index)
      }
    }
  })

  it('sizes the shards from the real test tree and keeps them within 2x of each other', () => {
    const counts = new Array<number>(WINDOWS_TEST_SHARD_COUNT).fill(0)
    for (const file of testFiles) counts[windowsTestShard(file) - 1] += 1

    // Sanity: the walk must actually see the suite, otherwise the sizing check below is vacuous.
    expect(testFiles.length).toBeGreaterThan(1000)

    const populated = counts.filter((count) => count > 0)
    expect(populated.length).toBe(WINDOWS_TEST_SHARD_COUNT)

    const smallest = Math.min(...counts)
    const largest = Math.max(...counts)
    const ratio = largest / smallest

    // Reported so a CI log carries the measurement, not just a verdict.
    console.log(
      `[windows shards] total=${testFiles.length} per-shard=${counts.join('/')} max/min=${ratio.toFixed(2)}`
    )

    // The point of module sharding is even wall time; an unbalanced split means the manifest below
    // (or the module layout) drifted and one runner will hit the job timeout again.
    expect(ratio).toBeLessThanOrEqual(2)
  })

  it('assigns every discovered file to a shard inside the declared range', () => {
    const outOfRange = testFiles.filter((file) => {
      const shard = windowsTestShard(file)
      return !Number.isInteger(shard) || shard < 1 || shard > WINDOWS_TEST_SHARD_COUNT
    })

    expect(outOfRange).toEqual([])
  })

  it('names the module families the Windows lane is built around', () => {
    // Guards the split's intent: if a family is dropped from the manifest its tests fall into the
    // catch-all shard, which is exactly the imbalance the grouping exists to prevent.
    const prefixes = WINDOWS_TEST_MODULE_GROUPS.flat() as readonly string[]
    for (const family of [
      'src/main/notebook/',
      'src/main/settings/',
      'src/main/acp/',
      'src/main/connectors/',
      'src/main/artifacts/',
      'src/renderer/src/pages/workspace/'
    ]) {
      expect(prefixes).toContain(family)
    }
    expect(WINDOWS_TEST_MODULE_GROUPS).toHaveLength(WINDOWS_TEST_SHARD_COUNT - 1)
  })

  it('routes repository-relative paths, not absolute ones', () => {
    // The sequencer compares against `relative(root, moduleId)`; an absolute path would match no
    // prefix and silently push every file into the catch-all shard.
    expect(relative(REPO_ROOT, REPO_ROOT)).toBe('')
    const absolute = join(REPO_ROOT, 'src/main/notebook/runtime-service.test.ts')
    expect(windowsTestShard(relative(REPO_ROOT, absolute))).toBe(3)
  })
})
