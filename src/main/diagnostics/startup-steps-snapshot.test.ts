import { describe, expect, it } from 'vitest'

import { createStartupStepsHolder } from './startup-steps-snapshot'
import type { ComposeStepsSnapshot } from './compose-steps'

const snapshot = (totalMs: number): ComposeStepsSnapshot => ({
  totalMs,
  stepMs: totalMs - 10,
  gapMs: 10,
  steps: [
    {
      name: 'open-project-db',
      durationMs: totalMs - 10,
      outcome: 'ok',
      cpuMs: 12,
      cpuShare: 0.4,
      attribution: 'inconclusive'
    }
  ]
})

describe('startup steps holder', () => {
  // The absent state is the one a support bundle reads when composition has not closed yet. It has to name
  // itself: an empty step list would read as "startup took no time", which is the opposite of what happened.
  it('names the absent state instead of returning an empty window', () => {
    const holder = createStartupStepsHolder()

    expect(holder.summary()).toEqual({
      status: 'not-recorded',
      reason: 'composition-not-finished'
    })
  })

  it('hands back the recorded window unchanged, including the arithmetic it was built with', () => {
    const holder = createStartupStepsHolder()

    holder.record(snapshot(1_200))

    const summary = holder.summary()
    expect(summary.status).toBe('recorded')
    expect(summary).toMatchObject({ totalMs: 1_200, stepMs: 1_190, gapMs: 10 })
    if (summary.status === 'recorded') {
      // The step list survives the holder untouched: the artifact must not be a re-derivation of the window.
      expect(summary.steps[0].name).toBe('open-project-db')
      expect(summary.steps).toHaveLength(1)
    }
  })

  it('keeps the newest window only, because a report is about the startup that just happened', () => {
    const holder = createStartupStepsHolder()

    holder.record(snapshot(1_200))
    holder.record(snapshot(2_400))

    expect(holder.summary()).toMatchObject({ status: 'recorded', totalMs: 2_400 })
  })

  it('can be cleared back to the absent state, so a test never inherits another test’s window', () => {
    const holder = createStartupStepsHolder()
    holder.record(snapshot(1_200))

    holder.clear()

    expect(holder.summary().status).toBe('not-recorded')
  })
})
