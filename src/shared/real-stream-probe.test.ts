import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planSupervisorWakes, supervisorEventsFromActivities } from './supervisor-signals'

// Throwaway diagnostic: runs the real wake policy over a real recorded session so "the ledger never fires"
// can be attributed to the policy or to the wiring, instead of guessed at.
const findSession = (): { file: string; activities: unknown[] } | undefined => {
  const root = join(homedir(), '.purescience-project', 'sessions')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json') && !entry.name.endsWith('.summary.json')) files.push(full)
    }
  }
  walk(root)
  let best: { file: string; activities: unknown[]; mtime: number } | undefined
  for (const file of files) {
    let parsed: { session?: { title?: string; activities?: unknown[] } }
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const session = parsed.session
    if (!session?.title?.includes('nonexistent')) continue
    const mtime = statSync(file).mtimeMs
    if (!best || mtime > best.mtime) {
      best = { file, activities: session.activities ?? [], mtime }
    }
  }
  return best ? { file: best.file, activities: best.activities } : undefined
}

describe('real recorded stream', () => {
  it('reports what the policy makes of it', () => {
    const found = findSession()
    expect(found).toBeDefined()
    const activities = (found?.activities ?? []) as Array<{
      id: string
      status: string
      providerToolName?: string
      title?: string
    }>
    const events = supervisorEventsFromActivities(activities)
    const plan = planSupervisorWakes(events)
    console.log(
      'PROBE_TITLES',
      JSON.stringify(
        ((): string[] => {
          const root = join(homedir(), '.purescience-project', 'sessions')
          const out: string[] = []
          const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name)
              if (entry.isDirectory()) walk(full)
              else if (entry.name.endsWith('.json') && !entry.name.endsWith('.summary.json')) {
                try {
                  const parsed = JSON.parse(readFileSync(full, 'utf8')) as {
                    session?: { title?: string }
                  }
                  if (parsed.session?.title) out.push(parsed.session.title.slice(0, 70))
                } catch {
                  /* skip */
                }
              }
            }
          }
          walk(root)
          return out.slice(-6)
        })()
      )
    )
    console.log(
      'PROBE_RESULT',
      JSON.stringify({
        file: found?.file,
        activities: activities.length,
        failedEvents: events.filter((event) => event.ok === false).length,
        wakes: plan.wakes.map((wake) => `${wake.kind}@${wake.atTurn}`),
        degraded: plan.degraded?.skipped ?? null
      })
    )
    expect(activities.length).toBeGreaterThan(0)
  })
})
