import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// `settings.json` keeps one write queue per SettingsRepository instance, and the Compute module's
// legacy grant import writes that file during startup (`clearComputeGrants`) while the settings
// service is writing the same file. Two instances therefore meant two queues and two whole-file
// rewrites racing on one file; on Windows the loser's rename failed outright with
// `EPERM: operation not permitted, rename` (103 of 257 spec app-logs in one P0 run).
//
// The fix is structural — one repository constructed in the composition root and handed to both
// owners — so the pin is structural too. A second `new SettingsRepository(...)` in the composition
// would silently reintroduce the race: no test, typecheck or lint would notice.
const projectRoot = resolve(__dirname, '../../..')
const ipcSource = readFileSync(resolve(projectRoot, 'src/main/ipc.ts'), 'utf8')

const occurrences = (source: string, token: string): number => source.split(token).length - 1

describe('settings repository wiring', () => {
  it('reads the real composition source, not a truncated copy', () => {
    // A short file would make the counts below pass vacuously.
    expect(ipcSource.length).toBeGreaterThan(100_000)
  })

  it('constructs exactly one settings repository', () => {
    expect(occurrences(ipcSource, 'new SettingsRepository(')).toBe(1)
  })

  it('hands that instance to both the settings service and the Compute module', () => {
    expect(ipcSource).toContain('new SettingsService({ repository: settingsRepository })')
    const call = /createComputeIpcModule\(([\s\S]*?)\n {2}\)/.exec(ipcSource)
    expect(call).not.toBeNull()
    // Last argument, so the seven positional seams above it keep their meaning.
    expect(call?.[1].trimEnd().endsWith('settingsRepository')).toBe(true)
  })

  it('does not fall back to the default settings service factory', () => {
    // That factory builds its own repository — using it here would undo the sharing above while
    // leaving this file's other pins green.
    expect(ipcSource).not.toContain('createDefaultSettingsService()')
  })
})
