import { describe, expect, it } from 'vitest'

import { sanitizeAcpContextUsage, toAcpTurnTokenUsage } from './acp'

const usageWith = (breakdown: Record<string, unknown>): Record<string, unknown> => ({
  used: 100,
  breakdown: {
    source: 'estimated',
    estimatedTokens: 40,
    difference: 0,
    status: 'preflight',
    categories: [{ key: 'mcp', tokens: 40, estimated: true }],
    ...breakdown
  }
})

describe('sanitizeAcpContextUsage section detail', () => {
  it('round-trips the per-section sizes that make per-server definition cost observable', () => {
    expect(
      sanitizeAcpContextUsage(
        usageWith({
          sections: [
            { sectionId: 'mcp-schema:purescience-notebook', category: 'mcp', tokens: 30 },
            { sectionId: 'system:persistent', category: 'system', tokens: 10 }
          ]
        })
      )?.breakdown?.sections
    ).toEqual([
      { sectionId: 'mcp-schema:purescience-notebook', category: 'mcp', tokens: 30 },
      { sectionId: 'system:persistent', category: 'system', tokens: 10 }
    ])
  })

  it('omits the field entirely when nothing was attributed', () => {
    expect(sanitizeAcpContextUsage(usageWith({}))?.breakdown).not.toHaveProperty('sections')
    expect(sanitizeAcpContextUsage(usageWith({ sections: [] }))?.breakdown).not.toHaveProperty(
      'sections'
    )
  })

  it('drops only the detail when an entry is malformed, keeping the reconciled breakdown', () => {
    const usage = sanitizeAcpContextUsage(
      usageWith({
        sections: [
          { sectionId: 'mcp-schema:purescience-notebook', category: 'mcp', tokens: 30 },
          { sectionId: '', category: 'mcp', tokens: 5 },
          { sectionId: 'mcp-schema:x', category: 'not-a-category', tokens: 5 },
          { sectionId: 'mcp-schema:y', category: 'mcp', tokens: -1 }
        ]
      })
    )

    expect(usage?.breakdown).not.toHaveProperty('sections')
    expect(usage?.breakdown?.status).toBe('preflight')
    expect(usage?.breakdown?.categories).toEqual([{ key: 'mcp', tokens: 40, estimated: true }])
  })

  it('bounds the number of retained sections', () => {
    const sections = Array.from({ length: 70 }, (_value, index) => ({
      sectionId: `mcp-schema:server-${index}`,
      category: 'mcp',
      tokens: index + 1
    }))

    expect(sanitizeAcpContextUsage(usageWith({ sections }))?.breakdown?.sections).toHaveLength(64)
  })
})

describe('ACP turn token usage', () => {
  it('preserves cache details only when the agent reports both read and write categories', () => {
    expect(
      toAcpTurnTokenUsage({
        totalTokens: 160,
        inputTokens: 100,
        cachedReadTokens: 30,
        cachedWriteTokens: 20,
        outputTokens: 10
      })
    ).toEqual({
      inputTokens: 100,
      cacheTokens: 50,
      cachedReadTokens: 30,
      cachedWriteTokens: 20,
      outputTokens: 10
    })

    expect(
      toAcpTurnTokenUsage({
        totalTokens: 140,
        inputTokens: 100,
        cachedReadTokens: 30,
        outputTokens: 10
      })
    ).toEqual({ inputTokens: 100, cacheTokens: 30, outputTokens: 10 })
  })
})
