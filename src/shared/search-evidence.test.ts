import { describe, expect, it } from 'vitest'

import {
  SEARCH_EVIDENCE_MAX_SNIPPET,
  SEARCH_EVIDENCE_SCHEMA_VERSION,
  formatSearchEvidenceLine,
  searchEvidenceSnippet,
  type SearchEvidenceLine
} from './search-evidence'

const line: SearchEvidenceLine = {
  schemaVersion: SEARCH_EVIDENCE_SCHEMA_VERSION,
  projectId: 'project-a',
  sessionId: 'session-a',
  messageId: 'message-2',
  role: 'agent',
  capturedAt: '2026-09-14T10:00:00.000Z',
  query: 'sin csv',
  terms: ['sin', 'csv'],
  snippet: 'wrote sin(x) values to replay_probe.csv',
  fingerprint: `sha256:${'a'.repeat(64)}`
}

const labels = {
  header: 'Evidence',
  query: 'Query',
  terms: 'Terms',
  snippet: 'Snippet',
  fingerprint: 'Fingerprint'
}

describe('formatSearchEvidenceLine', () => {
  it('prints the identifiers, the query, the terms and the fingerprint', () => {
    const text = formatSearchEvidenceLine(line, labels)

    expect(text).toBe(
      [
        'Evidence: project-a / session-a / message-2 (agent) 2026-09-14T10:00:00.000Z',
        'Query: sin csv',
        'Terms: sin, csv',
        'Snippet: wrote sin(x) values to replay_probe.csv',
        `Fingerprint: sha256:${'a'.repeat(64)}`
      ].join('\n')
    )
  })

  it('translates the labels without touching the fingerprint', () => {
    const text = formatSearchEvidenceLine(line, {
      header: '证据',
      query: '查询',
      terms: '术语',
      snippet: '片段',
      fingerprint: '指纹'
    })

    expect(text).toContain('证据: project-a')
    expect(text).toContain('查询: sin csv')
    expect(text).toContain(`指纹: sha256:${'a'.repeat(64)}`)
  })

  it('keeps an empty term list visible rather than dropping the line', () => {
    const text = formatSearchEvidenceLine({ ...line, terms: [] }, labels)

    expect(text).toContain('Terms: ')
  })
})

describe('searchEvidenceSnippet', () => {
  it('leaves a short text alone and marks a cut one', () => {
    expect(searchEvidenceSnippet('short')).toBe('short')

    const long = 'x'.repeat(SEARCH_EVIDENCE_MAX_SNIPPET + 50)
    const snippet = searchEvidenceSnippet(long)
    expect(snippet).toHaveLength(SEARCH_EVIDENCE_MAX_SNIPPET + 1)
    expect(snippet.endsWith('…')).toBe(true)
  })
})
