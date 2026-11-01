import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Playwright imports every test file in a worker before running the first one, so `process.env.X = …`
// written at module scope is in force for the WHOLE suite from collection time — the file's own
// afterAll is far too late. That is not a theory: the packaged P0 lane (Nightly b96f7851) went red on
// all four literature-screening specs because three specs set `PURESCIENCE_E2E_TOOL_EVENTS = '2'` at
// module scope, the fake agent then interleaved tool calls into every reply of the suite, and the
// screening runner refuses a backend that touches a tool. The same spec passed on its own against the
// same packaged binary in the same job. Environment that changes a launch belongs to the spec that
// needs it: `scopeEnvironmentToThisSpec` (e2e/fixtures/spec-environment.ts) sets it in `beforeAll` and
// puts the previous value back in `afterAll`.

const E2E_ROOT = resolve('e2e')
/** A spec file may not assign at column 0 — that is module scope, i.e. before any hook runs. */
const MODULE_SCOPE_ASSIGNMENT = /^process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=(?!=)/
const ASSIGNED = /process\.env\.([A-Z][A-Z0-9_]*)\s*=(?!=)/g
const RESTORED = /delete process\.env\.([A-Z][A-Z0-9_]*)/g
const SCOPED_HELPER = 'scopeEnvironmentToThisSpec'

const sourcesUnder = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await sourcesUnder(path)))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

const names = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map((match) => match[1])

describe('spec environment stays inside the spec that sets it', () => {
  it('no spec assigns process.env at module scope, and every value it sets is restored', async () => {
    const files = await sourcesUnder(E2E_ROOT)
    // Self-check: a broken walk would report zero violations for a directory it never opened.
    expect(files.length).toBeGreaterThan(120)

    const violations: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      const where = relative(process.cwd(), file)
      text.split('\n').forEach((line, index) => {
        if (MODULE_SCOPE_ASSIGNMENT.test(line)) {
          violations.push(`${where}:${index + 1} sets an environment variable at module scope`)
        }
      })

      if (text.includes(SCOPED_HELPER)) continue
      const restored = new Set(names(text, RESTORED))
      for (const name of new Set(names(text, ASSIGNED))) {
        if (!restored.has(name)) violations.push(`${where} sets ${name} but never restores it`)
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })
})
