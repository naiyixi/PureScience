import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ClaudeInstallEvent } from '../../shared/settings'
import { installHermesWithPipx, resolvePipxPath } from './hermes-install'

const scratch: string[] = []

const fakePipx = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pipx-fake-'))
  scratch.push(dir)
  const path = join(dir, 'pipx')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
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
    const result = await installHermesWithPipx({ installId: 'i1', pipxPath: null, onEvent: () => {} })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('pipx was not found')
    expect(result.error).toContain('brew install pipx')
    expect(result.error).toContain('python3 -m pip install --user pipx')
    // A missing installer must not pretend to have started: no progress event is emitted.
    expect(events).toHaveLength(0)
  })

  it('streams pipx output while it runs and succeeds on exit 0', async () => {
    const { events, onEvent } = collect()
    const pipx = fakePipx('echo "installing hermes-agent"; echo "done" >&2; exit 0')

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
    const pipx = fakePipx('echo "error: no matching distribution found" >&2; exit 3')

    const result = await installHermesWithPipx({ installId: 'i3', pipxPath: pipx, onEvent })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.error).toContain('no matching distribution found')
  })

  it('stops a hung pipx at the deadline and says it was stopped', async () => {
    const pipx = fakePipx('sleep 30')

    const result = await installHermesWithPipx({
      installId: 'i4',
      pipxPath: pipx,
      onEvent: () => {},
      timeoutMs: 250
    })

    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.error).toContain('did not finish')
  })

  it('resolves a candidate only when it exists', () => {
    expect(resolvePipxPath(() => false)).toBeNull()
    const found = resolvePipxPath((candidate) => candidate.endsWith('homebrew/bin/pipx'))
    expect(found).toContain('homebrew/bin/pipx')
  })
})
