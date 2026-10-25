import { describe, expect, it } from 'vitest'

import { extractToolCalls } from './extract-tool-calls'

// The session is the only authority for what ran; these cases pin that the extractor reads it the same
// way the rest of the app does (bench-evidence) and never invents a tool name it did not find.

describe('extractToolCalls', () => {
  it('reads the name in the same precedence bench-evidence uses', () => {
    const { calls, unnamed } = extractToolCalls({
      activities: [
        { id: 'a1', providerToolName: 'memory_save_note', toolKind: 'other', title: 'Save' },
        { id: 'a2', toolKind: 'notebook_execute', title: 'Run cell' },
        { id: 'a3', title: 'Read file' }
      ]
    })

    expect(calls.map((call) => call.tool)).toEqual([
      'memory_save_note',
      'notebook_execute',
      'Read file'
    ])
    expect(calls.map((call) => call.turnId)).toEqual(['a1', 'a2', 'a3'])
    expect(unnamed).toBe(0)
  })

  it('counts an activity with no usable name instead of inventing one', () => {
    const { calls, unnamed } = extractToolCalls({
      activities: [{ id: 'a1' }, { id: 'a2', title: '   ' }, { id: 'a3', toolKind: 'bash' }]
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.tool).toBe('bash')
    expect(unnamed).toBe(2)
  })

  it('derives a duration from the timestamps when the activity carries none', () => {
    const { calls } = extractToolCalls({
      activities: [{ id: 'a1', title: 'x', startedAt: 1000, completedAt: 1450 }]
    })

    expect(calls[0]?.durationMs).toBe(450)
  })

  it('omits fields it cannot know rather than writing zeros', () => {
    const { calls } = extractToolCalls({ activities: [{ id: 'a1', title: 'x' }] })

    expect(calls[0]).toEqual({ turnId: 'a1', tool: 'x' })
    expect(calls[0]?.durationMs).toBeUndefined()
    expect(calls[0]?.resultBytes).toBeUndefined()
  })

  it('returns nothing for a session without activities', () => {
    expect(extractToolCalls({}).calls).toEqual([])
    expect(extractToolCalls({ activities: [] }).calls).toEqual([])
    expect(extractToolCalls(undefined).calls).toEqual([])
  })
})
