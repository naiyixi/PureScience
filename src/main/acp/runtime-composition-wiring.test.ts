import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// A wiring guard, in the shape this repository uses for ports whose absence is invisible at runtime.
//
// Why it exists: `functionModels` was passed in by the app's composition and then silently dropped, because
// the ACP composition's own options type did not name it and the runtime options object did not forward it.
// Nothing failed — the skill-selection bridge on the turn path simply had no host, so the configured
// function model was never consulted there and no outcome was recorded. A dropped option cannot throw, so a
// source-level tripwire is the only cheap way to keep it from being dropped again.
//
// The real-machine reading that proved it: docs/evidence/2026-10-02-codex-turn-bridge-measurement.md
describe('ACP composition forwards the function-model host', () => {
  const source = readFileSync(resolve(__dirname, 'runtime-composition.ts'), 'utf8')

  it('declares the field on the composition options', () => {
    expect(source).toContain("functionModels?: AcpRuntimeOptions['functionModels']")
  })

  it('takes it from the incoming options', () => {
    expect(source).toMatch(/\n\s*settingsService,\n\s*functionModels,/)
  })

  it('forwards it into the runtime options the bridge reads', () => {
    expect(source).toContain('...(functionModels ? { functionModels } : {})')
  })
})
