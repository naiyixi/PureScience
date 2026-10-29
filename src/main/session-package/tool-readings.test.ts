import { createHash } from 'node:crypto'

import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'

import { TOOL_CALL_READINGS_RECIPE } from '../../shared/tool-call-readings'
import { buildToolCallReadings, verifyToolCallReadings } from './tool-readings'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const session = (activities: unknown[]): unknown => ({
  id: 'session-1',
  messages: [],
  activities
})

describe('buildToolCallReadings', () => {
  it('says "this session ran no tools" only when the session holds no activity rows', () => {
    expect(buildToolCallReadings(session([])).summary).toEqual({
      recipe: TOOL_CALL_READINGS_RECIPE,
      state: 'absent:no-tool-calls',
      unnamed: 0
    })
    // No document at all is the same honest answer.
    expect(buildToolCallReadings({ id: 's', messages: [] }).summary.state).toBe(
      'absent:no-tool-calls'
    )
    expect(buildToolCallReadings(session([])).file).toBeUndefined()
  })

  it('carries one row per named call, with the readings the session recorded', () => {
    const built = buildToolCallReadings(
      session([
        {
          id: 'a1',
          providerToolName: 'notebook_execute',
          status: 'completed',
          startedAt: 1000,
          completedAt: 3400,
          outputBytes: 2048
        },
        { id: 'a2', toolKind: 'search', status: 'completed', durationMs: 90 }
      ])
    )

    expect(built.file?.path).toBe('evidence/tool-calls.json')
    const parsed = JSON.parse(strFromU8(built.file?.contents as Uint8Array)) as {
      recipe: string
      rows: Array<Record<string, unknown>>
      unnamed: number
    }
    expect(parsed.recipe).toBe(TOOL_CALL_READINGS_RECIPE)
    expect(parsed.rows.map((row) => row.tool)).toEqual(['notebook_execute', 'search'])
    expect(parsed.rows[0]).toEqual({
      turnId: 'a1',
      tool: 'notebook_execute',
      durationMs: 2400,
      resultBytes: 2048
    })
    expect(parsed.rows[1]).toEqual({ turnId: 'a2', tool: 'search', durationMs: 90 })
    expect(parsed.unnamed).toBe(0)
    if (built.summary.state !== 'included') throw new Error('expected an included summary')
    expect(built.summary.rows).toBe(2)
    // 摘要按**实际写进包的字节**算：第三方拿着这批字节能得出同一个值。
    expect(built.summary.sha256).toBe(sha256(built.file?.contents as Uint8Array))
  })

  it('counts the activities it could not name instead of reporting "no tool calls"', () => {
    const built = buildToolCallReadings(
      session([
        { id: 'a1', status: 'completed' },
        { id: 'a2', status: 'failed' }
      ])
    )
    expect(built.summary).toMatchObject({
      recipe: TOOL_CALL_READINGS_RECIPE,
      state: 'included',
      rows: 0,
      unnamed: 2
    })
    expect(built.file).toBeDefined()
  })
})

describe('verifyToolCallReadings', () => {
  const built = buildToolCallReadings(
    session([{ id: 'a1', providerToolName: 'notebook_execute', durationMs: 120 }])
  )

  it('accepts the declaration the exporter wrote for the bytes it packed', () => {
    expect(verifyToolCallReadings(built.summary, built.file?.contents)).toEqual({
      state: 'match',
      rows: 1,
      unnamed: 0
    })
  })

  it('catches a single changed byte', () => {
    const tampered = new Uint8Array(built.file?.contents as Uint8Array)
    const index = tampered.length - 3
    tampered[index] = tampered[index] === 0x20 ? 0x21 : 0x20
    const verdict = verifyToolCallReadings(built.summary, tampered)
    expect(verdict.state).toBe('mismatch')
    expect(verdict.state === 'mismatch' ? verdict.fields : []).toContain('sha256')
  })

  it('catches a declaration that overstates how many calls travelled', () => {
    if (built.summary.state !== 'included') throw new Error('expected an included summary')
    const inflated = { ...built.summary, rows: 9 }
    expect(verifyToolCallReadings(inflated, built.file?.contents)).toEqual({
      state: 'mismatch',
      fields: ['rows']
    })
  })

  it('reports a missing file as unverifiable, never as a match', () => {
    expect(verifyToolCallReadings(built.summary, undefined)).toEqual({
      state: 'underivable',
      reason: 'file-missing'
    })
  })
})
