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
      // Deliberately ahead of the stored-settings read: the probe answers it restores are what the
      // preflight asks for on the user's critical path (`opencode --version` 4,035.9 ms cold vs
      // 1.062 ms answered from the file), so the load has to be inside the attributed window too.
      'load-probe-answers',
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

  // The log line answers "how long did startup take" for whoever is looking at that launch. The support bundle
  // answers the same question hours later, for a user who only has a .tar.gz to send — and it can only answer
  // it if the composition root leaves the window where `getFacts` reads it. Twice now the missing piece in a
  // slow-start report was exactly this: the reading existed and never reached the artifact.
  it('leaves the same window where the support bundle reads it', () => {
    expect(ipcSource).toContain("from './diagnostics/startup-steps-snapshot'")
    const recorded = ipcSource.indexOf('sharedStartupSteps.record(composeSteps.snapshot())')
    const summaryLine = ipcSource.indexOf('composeSteps.logSummary()')
    const lastStep = ipcSource.lastIndexOf('await composeSteps.step(')
    expect(recorded).toBeGreaterThan(lastStep)
    // Recorded beside the summary line, not somewhere earlier: a snapshot taken before the last step would
    // ship a window that is still open.
    expect(recorded).toBeGreaterThan(summaryLine)
    // And the facts the bundle is built from must actually carry it — a recorded window nobody reads is a
    // reading the user never receives.
    expect(ipcSource).toContain('startupSteps: sharedStartupSteps.summary()')
  })
})
