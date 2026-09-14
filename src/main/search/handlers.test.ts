import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { createSearchHandlers } from './handlers'

const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Sine plot',
    createdAt: 1_789_000_000_000,
    updatedAt: 1_789_000_060_000,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'write replay_probe.csv',
        status: 'complete',
        eventIds: []
      },
      {
        id: 'message-2',
        role: 'agent',
        content: 'wrote sin(x) values to replay_probe.csv',
        status: 'complete',
        eventIds: []
      }
    ],
    ...overrides
  }) as unknown as PersistedChatSession

const harness = (
  overrides: Partial<Parameters<typeof createSearchHandlers>[0]> = {}
): {
  query: ReturnType<typeof createSearchHandlers>['query']
  listFiles: ReturnType<typeof vi.fn>
  listReferences: ReturnType<typeof vi.fn>
} => {
  const listFiles = vi.fn(async () => ({
    files: [{ id: 'file-1', title: 'sin_probe.csv', relativePath: 'data/sin_probe.csv' }]
  }))
  const listReferences = vi.fn(async () => [
    { id: 'ref-1', title: 'A study of sin', abstract: 'sin everywhere' }
  ])
  const handlers = createSearchHandlers({
    loadSessions: async () => [session()],
    listFiles,
    listReferences,
    ...overrides
  })

  return { query: handlers.query, listFiles, listReferences }
}

describe('createSearchHandlers', () => {
  it('says the file list was bounded, so a miss cannot read as absence', async () => {
    const { query } = harness({
      listFiles: vi.fn(async () => ({
        files: [{ id: 'file-1', title: 'notes.md', relativePath: 'notes.md' }],
        listBounded: true
      }))
    })

    const response = await query({ query: 'sin', scopes: ['files'], projectId: 'project-1' })

    expect(response.notes).toContain('file-list-bounded')
  })

  it('reads file text through the port so content matches are found', async () => {
    const readFileText = vi.fn(async () => 'the sin(x) series was computed here')
    const { query } = harness({
      // A file whose name and path say nothing about the query: only its content can match.
      listFiles: vi.fn(async () => ({
        files: [{ id: 'file-9', title: 'notes.md', relativePath: 'notes.md' }]
      })),
      readFileText
    })

    const response = await query({ query: 'sin', scopes: ['files'], projectId: 'project-1' })

    expect(readFileText).toHaveBeenCalledWith('file-9')
    expect(response.hits).toHaveLength(1)
    expect(response.hits[0].matches[0].field).toBe('content')
    // A content provider exists, so the name-and-path-only note must not appear.
    expect(response.notes).not.toContain('files-matched-by-name-and-path')
  })

  it('stops at the content budget and says so instead of implying every file was read', async () => {
    const fileCount = 45
    const readFileText = vi.fn(async () => 'nothing relevant here')
    const { query } = harness({
      listFiles: vi.fn(async () => ({
        files: Array.from({ length: fileCount }, (_, index) => ({
          id: `file-${index}`,
          title: `note-${index}.md`,
          relativePath: `note-${index}.md`
        }))
      })),
      readFileText
    })

    const response = await query({ query: 'sin', scopes: ['files'], projectId: 'project-1' })

    expect(readFileText).toHaveBeenCalledTimes(40)
    expect(response.notes).toContain('file-content-scan-bounded')
  })

  it('does not claim a bounded content scan when no provider is wired', async () => {
    const { query } = harness()

    const response = await query({ query: 'sin', scopes: ['files'], projectId: 'project-1' })

    expect(response.notes).not.toContain('file-content-scan-bounded')
    expect(response.notes).toContain('files-matched-by-name-and-path')
  })
  it('maps persisted sessions and messages into the search contract', async () => {
    const { query } = harness()
    const response = await query({ query: 'sin', scopes: ['sessions', 'messages'] })

    const messages = response.hits.find((hit) => hit.scope === 'messages')
    expect(messages).toMatchObject({
      id: 'message-2',
      sessionId: 'session-1',
      messageIndex: 1,
      role: 'agent'
    })
    // Epoch-millisecond session timestamps become ISO-8601 in the contract.
    expect(messages?.timestamp).toBe(new Date(1_789_000_060_000).toISOString())
  })

  it('says a project-less query cannot reach files or literature', async () => {
    const { query, listFiles, listReferences } = harness()
    const response = await query({ query: 'sin' })

    expect(response.notes).toContain('no-project-scope')
    expect(listFiles).not.toHaveBeenCalled()
    expect(listReferences).not.toHaveBeenCalled()
  })

  it('reads files and literature only for a project, and only when asked', async () => {
    const { query, listFiles, listReferences } = harness()
    const response = await query({ query: 'sin', projectId: 'project-1', scopes: ['files'] })

    expect(listFiles).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(listReferences).not.toHaveBeenCalled()
    expect(response.notes).not.toContain('no-project-scope')
    expect(response.hits.map((hit) => hit.scope)).toEqual(['files'])
  })

  it('searches the literature library when asked', async () => {
    const { query } = harness()
    const response = await query({ query: 'sin', projectId: 'project-1', scopes: ['literature'] })

    expect(response.hits).toHaveLength(1)
    expect(response.hits[0]).toMatchObject({
      scope: 'literature',
      id: 'ref-1',
      projectId: 'project-1'
    })
  })

  it('reports the scan even when a scope found nothing', async () => {
    const { query } = harness()
    const response = await query({ query: 'absent', projectId: 'project-1' })

    expect(response.hits).toEqual([])
    expect(response.scan.messages).toBe(2)
    expect(response.scan.files).toBe(1)
    expect(response.scan.references).toBe(1)
  })
})
