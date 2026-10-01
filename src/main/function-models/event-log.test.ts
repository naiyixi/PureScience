import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  FUNCTION_MODEL_EVENT_LOG_LIMIT,
  appendFunctionModelEvent,
  functionModelEventLogPath,
  readFunctionModelEvents
} from './event-log'

// The trail is how "why did this run not use the model I configured" gets an answer instead of a shrug.
// These cases pin its two hard properties: it is bounded, and it never resurrects a shape it cannot read.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ps-function-model-events-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('function model event log', () => {
  it('reads an absent file as an empty trail', () => {
    expect(readFunctionModelEvents(root)).toEqual([])
  })

  it('records what a function did, newest last', () => {
    appendFunctionModelEvent(root, {
      functionId: 'skill-selection',
      outcome: 'built-in',
      reason: 'not-configured',
      at: 1
    })
    appendFunctionModelEvent(root, {
      functionId: 'skill-selection',
      outcome: 'used-model',
      providerId: 'provider-a',
      model: 'small-model',
      at: 2
    })

    expect(readFunctionModelEvents(root)).toEqual([
      { functionId: 'skill-selection', outcome: 'built-in', reason: 'not-configured', at: 1 },
      {
        functionId: 'skill-selection',
        outcome: 'used-model',
        providerId: 'provider-a',
        model: 'small-model',
        at: 2
      }
    ])
  })

  it('keeps the trail bounded, dropping the oldest entries', () => {
    for (let index = 0; index < FUNCTION_MODEL_EVENT_LOG_LIMIT + 5; index += 1) {
      appendFunctionModelEvent(root, {
        functionId: 'skill-selection',
        outcome: 'built-in',
        reason: 'not-configured',
        at: index
      })
    }

    const kept = readFunctionModelEvents(root)
    expect(kept).toHaveLength(FUNCTION_MODEL_EVENT_LOG_LIMIT)
    // The oldest five are the ones gone — a bounded log that dropped the newest would be useless.
    expect(kept[0].at).toBe(5)
    expect(kept.at(-1)?.at).toBe(FUNCTION_MODEL_EVENT_LOG_LIMIT + 4)
  })

  it('drops entries whose shape this build does not recognise', () => {
    writeFileSync(
      functionModelEventLogPath(root),
      JSON.stringify([
        { at: 1, functionId: 'skill-selection', outcome: 'built-in', reason: 'not-configured' },
        // A slot for a function this build does not have, and an outcome that is not one of ours.
        { at: 2, functionId: 'literature-classification', outcome: 'built-in' },
        { at: 3, functionId: 'skill-selection', outcome: 'maybe' },
        { at: 4, functionId: 'skill-selection', outcome: 'built-in', reason: 'invented' },
        'not an object'
      ]),
      'utf8'
    )

    expect(readFunctionModelEvents(root)).toEqual([
      { at: 1, functionId: 'skill-selection', outcome: 'built-in', reason: 'not-configured' },
      // The unrecognised reason is dropped rather than carried: the entry is still readable, the reason is not.
      { at: 4, functionId: 'skill-selection', outcome: 'built-in' }
    ])
  })

  it('reads a malformed file as an empty trail instead of throwing', () => {
    writeFileSync(functionModelEventLogPath(root), '{ not json', 'utf8')

    expect(readFunctionModelEvents(root)).toEqual([])
  })
})
