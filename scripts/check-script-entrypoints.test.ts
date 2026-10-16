import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { LAUNCHER_ROOTS, MIN_LAUNCHERS } from './check-script-entrypoints.mjs'

// What this suite holds the gate to: that it really looks at the tree, and that its two ways of not
// looking (an empty walk, a root that moved) fail instead of reporting the same "✓ … 0 problems" a
// clean tree reports. The duplicate-export file below is the exact shape that reached a release: the
// gate has to name that file and Node's own words for why.

const cliPath = fileURLToPath(new URL('./check-script-entrypoints.mjs', import.meta.url))

const runGate = (
  args: string[] = []
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings=MODULE_TYPELESS_PACKAGE_JSON', cliPath, ...args],
    { encoding: 'utf8' }
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const trees: string[] = []

const makeRoots = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'script-entrypoints-'))
  trees.push(root)
  for (const candidate of LAUNCHER_ROOTS) mkdirSync(join(root, candidate), { recursive: true })
  return root
}

afterEach(() => {
  for (const root of trees.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('script entrypoint parse gate', () => {
  it('passes on this repository, and reports how many launchers it looked at', () => {
    const result = runGate()

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const count = Number(/✓ script entrypoints: (\d+) launcher/.exec(result.stdout)?.[1])
    // The count is the point: a gate that scanned one file would otherwise print the same ✓.
    expect(count).toBeGreaterThanOrEqual(MIN_LAUNCHERS)
  })

  it('fails on a launcher Node cannot link, naming the file and the reason', () => {
    const root = makeRoots()
    writeFileSync(
      join(root, 'scripts', 'dup-export.mjs'),
      'export const a = 1\nexport function b() {\n  return a\n}\nexport { a, b }\n'
    )

    const result = runGate([root])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('dup-export.mjs')
    expect(result.stderr).toContain("Duplicate export of 'b'")
  })

  it('fails when the walk finds nothing, rather than reporting a clean tree', () => {
    const result = runGate([makeRoots()])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('floor')
  })

  it('fails when a launcher directory is gone instead of scanning one place fewer', () => {
    const root = mkdtempSync(join(tmpdir(), 'script-entrypoints-'))
    trees.push(root)
    mkdirSync(join(root, 'scripts'), { recursive: true })

    const result = runGate([root])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cli/ does not exist')
  })
})
