import { describe, expect, it } from 'vitest'

import { benchEvidenceFromSession } from './bench-evidence'
import type { PersistedArtifact, PersistedChatSession } from './session-persistence'

const session = (parts: Partial<PersistedChatSession>): PersistedChatSession =>
  ({ messages: [], activities: [], ...parts }) as unknown as PersistedChatSession

const message = (role: string, content: string): { role: string; content: string } => ({
  role,
  content
})

describe('benchEvidenceFromSession', () => {
  it('builds a transcript from every non-empty message and agent turns separately', () => {
    const evidence = benchEvidenceFromSession(
      session({
        messages: [
          message('user', '分析这批数据'),
          message('agent', '先做质控'),
          message('agent', '   ')
        ] as never
      }),
      []
    )
    expect(evidence.transcript).toBe('分析这批数据\n先做质控')
    expect(evidence.turns).toEqual(['先做质控'])
    expect(evidence.collected.transcript).toBe(true)
  })

  it('turns tool activities into calls, preferring the provider tool name', () => {
    const evidence = benchEvidenceFromSession(
      session({
        activities: [
          {
            id: 'a1',
            kind: 'tool',
            title: 'Search PubMed',
            status: 'completed',
            sortIndex: 0,
            eventIds: [],
            providerToolName: 'search_articles',
            rawInput: { query: 'EGFR' },
            createdAt: 1,
            updatedAt: 2
          },
          {
            id: 'a2',
            kind: 'tool',
            title: 'Write artifact',
            status: 'completed',
            sortIndex: 1,
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ] as never
      }),
      []
    )
    expect(evidence.toolCalls).toEqual([
      { name: 'search_articles', args: { query: 'EGFR' } },
      { name: 'Write artifact' }
    ])
    expect(evidence.collected.toolCalls).toBe(true)
  })

  it('carries artifact paths and never invents quantities or citations', () => {
    const artifacts: Pick<PersistedArtifact, 'path'>[] = [{ path: 'out/figure.png' }]
    const evidence = benchEvidenceFromSession(session({}), artifacts)
    expect(evidence.artifacts).toEqual(['out/figure.png'])
    expect(evidence.collected.artifacts).toBe(true)
    expect(evidence.numbers).toBeUndefined()
    expect(evidence.citations).toBeUndefined()
    expect(evidence.collected).toMatchObject({ numbers: false, citations: false })
  })

  it('omits empty collections instead of emitting empty arrays', () => {
    const evidence = benchEvidenceFromSession(session({}), [])
    expect(evidence.toolCalls).toBeUndefined()
    expect(evidence.artifacts).toBeUndefined()
    expect(evidence.transcript).toBe('')
    expect(evidence.collected).toEqual({
      transcript: false,
      toolCalls: false,
      artifacts: false,
      numbers: false,
      citations: false
    })
  })
})
