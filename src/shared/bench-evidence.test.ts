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

  it('prefers the artifact name over the stored content-blob path', () => {
    const artifacts: Pick<PersistedArtifact, 'path' | 'name'>[] = [
      { path: '/data/artifacts/p1/s1/.provenance/a/versions/b/content', name: 'ic50.png' },
      { path: '/data/artifacts/p1/s1/.provenance/c/versions/d/content' }
    ]
    const evidence = benchEvidenceFromSession(session({}), artifacts)
    // A filename-shaped check must see `ic50.png`, not the blob path that never ends in .png.
    expect(evidence.artifacts).toEqual([
      'ic50.png',
      '/data/artifacts/p1/s1/.provenance/c/versions/d/content'
    ])
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

  it('records which skill files the run opened, and ignores reads outside a skills directory', () => {
    const evidence = benchEvidenceFromSession(
      session({
        activities: [
          {
            id: 'a1',
            title: 'read',
            providerToolName: 'read',
            rawInput: { path: '/cfg/opencode/skills/os-evidence-grading/SKILL.md' }
          },
          {
            id: 'a2',
            title: 'read',
            providerToolName: 'read',
            rawInput: { file_path: '/tmp/notes/SKILL.md' }
          }
        ]
      } as never),
      []
    )

    // Consulting a skill is the one behaviour a gap notice is supposed to cause; an unrelated file
    // that happens to be called SKILL.md must not be counted as one.
    expect(evidence.skillsRead).toEqual(['os-evidence-grading'])
    expect(evidence.collected.skillReads).toBe(true)
  })

  it('says nothing was read when no skill file was opened', () => {
    const evidence = benchEvidenceFromSession(session({}), [])
    expect(evidence.skillsRead).toBeUndefined()
    expect(evidence.collected.skillReads).toBe(false)
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
      skillReads: false,
      numbers: false,
      citations: false
    })
  })
})
