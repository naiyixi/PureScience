import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The idle-loop guard runs inside the kernel interpreter (resources/notebook/python_loop.py): the main
// process cannot reach into a child's package state. These are source contracts — they exist so the
// guard cannot be dropped or moved off the request path without a red test. The behaviour itself is
// proven twice: the gated real-kernel case in python-loop.integration.test.ts (fake package, asserts
// the flag and the cap) and the real-package readings in
// docs/evidence/2026-11-06-kernel-idle-cpu-spin.md (97.6% -> 0.0% CPU while idle).
const LOOP = join(__dirname, '../../../resources/notebook/python_loop.py')

describe('kernel idle-loop guard', () => {
  const source = readFileSync(LOOP, 'utf8')

  it('runs at the end of every request, from the finally block so a raising cell still gets it', () => {
    expect(source).toMatch(/^def _apply_idle_loop_guards\(\):$/m)
    expect(source).toMatch(
      /finally:\n\s+_globals\["_read_capture_active"\] = False\n\s+_apply_idle_loop_guards\(\)\n\s+sys\.stdout, sys\.stderr = old_out, old_err/
    )
  })

  it('only looks at sys.modules: a kernel that never imported the package pays one lookup', () => {
    expect(source).toMatch(
      /def _apply_idle_loop_guards\(\):\n\s+module = sys\.modules\.get\("pymol"\)\n\s+if module is None:\n\s+return/
    )
  })

  it('clears the launcher-set loop flag and caps the redraw when the flag alone is not enough', () => {
    expect(source).toContain('options.keep_thread_alive = 0')
    expect(source).toMatch(
      /def _throttled_draw\(self, \*args, \*\*kwargs\):\n\s+time\.sleep\(0\.05\)/
    )
    expect(source).toContain('draw._purescience_throttled = True')
  })
})
