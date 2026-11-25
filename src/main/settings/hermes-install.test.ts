import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ClaudeInstallEvent } from '../../shared/settings'
import { installHermesWithPipx, resolvePipxPath } from './hermes-install'

const scratch: string[] = []
const isWindows = process.platform === 'win32'

// Each fake runs a real Node process instead of a POSIX shell snippet: a `#!/bin/sh` script is not runnable
// on Windows, and skipping the spawn cases there would leave untested — on the platform where it broke — the
// very path these cases exist to pin.
const FAKE_SOURCE: Record<'ok' | 'fail' | 'hang', string> = {
  ok: "console.log('installing hermes-agent')\nconsole.error('done')\nprocess.exit(0)",
  fail: "console.error('error: no matching distribution found')\nprocess.exit(3)",
  hang: 'setTimeout(() => {}, 30000)'
}

const fakePipx = (mode: keyof typeof FAKE_SOURCE): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pipx-fake-'))
  scratch.push(dir)
  const script = join(dir, 'fake-pipx.cjs')
  writeFileSync(script, FAKE_SOURCE[mode])

  if (isWindows) {
    // pipx installs itself as a .cmd shim on Windows, so the fake takes the same shape the app will meet.
    const shim = join(dir, 'pipx.cmd')
    writeFileSync(shim, `@echo off\r\nnode "${script}" %*\r\n`)
    return shim
  }

  const shim = join(dir, 'pipx')
  writeFileSync(shim, `#!/bin/sh\nexec node "${script}" "$@"\n`)
  chmodSync(shim, 0o755)
  return shim
}

const collect = (): { events: ClaudeInstallEvent[]; onEvent: (e: ClaudeInstallEvent) => void } => {
  const events: ClaudeInstallEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('hermes pipx installer', () => {
  it('reports a missing pipx with the two commands that fix it, and changes nothing', async () => {
    const { events } = collect()
    const result = await installHermesWithPipx({
      installId: 'i1',
      pipxPath: null,
      onEvent: () => {}
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('pipx was not found')
    expect(result.error).toContain('brew install pipx')
    expect(result.error).toContain('python3 -m pip install --user pipx')
    // A missing installer must not pretend to have started: no progress event is emitted.
    expect(events).toHaveLength(0)
  })

  it('streams pipx output while it runs and succeeds on exit 0', async () => {
    const { events, onEvent } = collect()
    const pipx = fakePipx('ok')

    const result = await installHermesWithPipx({ installId: 'i2', pipxPath: pipx, onEvent })

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    const streams = events.filter((event) => event.kind === 'log').map((event) => event.stream)
    expect(streams).toContain('stdout')
    expect(streams).toContain('stderr')
    // pipx has no byte accounting, so exactly one phase tick is expected — not a fabricated percentage.
    const progress = events.filter((event) => event.kind === 'progress')
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ phase: 'installing' })
  })

  it('surfaces pipx own last lines when it exits non-zero, instead of a generic message', async () => {
    const { onEvent } = collect()
    const pipx = fakePipx('fail')

    const result = await installHermesWithPipx({ installId: 'i3', pipxPath: pipx, onEvent })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.error).toContain('no matching distribution found')
  })

  it('stops a hung pipx at the deadline and says it was stopped', async () => {
    const pipx = fakePipx('hang')

    const result = await installHermesWithPipx({
      installId: 'i4',
      pipxPath: pipx,
      onEvent: () => {},
      timeoutMs: 1500
    })

    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.error).toContain('did not finish')
  }, 30_000)

  it('resolves a candidate only when it exists', () => {
    expect(resolvePipxPath(() => false)).toBeNull()
    // Windows candidates carry a console-script extension (pipx.exe/.cmd/.bat), so an exact
    // `endsWith(join('homebrew','bin','pipx'))` can never match there — which is what the Windows shard
    // caught. Match the segment structure instead, then assert the resolved basename is a pipx script.
    const found = resolvePipxPath((candidate) =>
      /homebrew[\\/]+bin[\\/]+pipx(\\.(exe|cmd|bat))?$/i.test(candidate)
    )
    expect(found).toMatch(/homebrew[\\/]+bin[\\/]+pipx/i)
  })
})
