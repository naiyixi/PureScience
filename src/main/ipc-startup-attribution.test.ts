import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Startup attribution is only as good as its coverage: the real record showed 26,960 ms to the window
// against 7,834 ms of timed steps, so every un-timed await between the recorder's creation and the
// summary line is a hole that makes a slow launch unattributable again. That set is an inventory here
// on purpose — adding a timed step (or dropping one) has to be an explicit, reviewable act.
const projectRoot = resolve(__dirname, '../..')
const ipcSource = readFileSync(resolve(projectRoot, 'src/main/ipc.ts'), 'utf8')

const occurrences = (source: string, token: string): number => source.split(token).length - 1

const timedStepNames = (source: string): string[] => {
  const pattern = /composeSteps\.step\(\s*\n?\s*'([^']+)'/g
  return [...source.matchAll(pattern)].map((match) => match[1])
}

describe('startup composition attribution', () => {
  it('reads the real composition source, not a truncated copy', () => {
    // A short file would make every list below pass vacuously.
    expect(ipcSource.length).toBeGreaterThan(100_000)
    expect(ipcSource).toContain('createApplicationModules')
  })

  it('times exactly the inventory of composition steps, in composition order', () => {
    expect(timedStepNames(ipcSource)).toEqual([
      'application-events',
      'settings-service',
      'read-stored-settings',
      'hydrate-child-proxy-runtime',
      'open-project-db',
      'restore-notification-inbox',
      'permission-grant-registry',
      'notebook-application',
      'specialist-skill-catalog',
      'specialist-package-snapshot',
      'builtin-catalog-ready'
    ])
  })

  it('measures the first database touch as its own step, before the work that waits on it', () => {
    const names = timedStepNames(ipcSource)
    const open = names.indexOf('open-project-db')
    const inbox = names.indexOf('restore-notification-inbox')
    // One combined number cannot separate a slow engine start (machine-side) from slow inbox work
    // (code-side); the split is what made the 573-7,672 ms readings interpretable.
    expect(open).toBeGreaterThan(-1)
    expect(inbox).toBeGreaterThan(open)
  })

  it('awaits every timed step, so no step can escape the window', () => {
    // An un-awaited `step(...)` still records a 0 ms entry and closes nothing: the awaits are the
    // difference between "attributed" and "looks attributed".
    expect(occurrences(ipcSource, 'composeSteps.step(')).toBe(timedStepNames(ipcSource).length)
    expect(occurrences(ipcSource, 'await composeSteps.step(')).toBe(
      occurrences(ipcSource, 'composeSteps.step(')
    )
  })

  it('closes the window with one summary line', () => {
    expect(occurrences(ipcSource, 'createComposeStepRecorder(')).toBe(1)
    expect(occurrences(ipcSource, 'composeSteps.logSummary()')).toBe(1)
  })
})
