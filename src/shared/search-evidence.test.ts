import { describe, expect, it } from 'vitest'

import {
  SEARCH_EVIDENCE_MAX_SNIPPET,
  SEARCH_EVIDENCE_SCHEMA_VERSION,
  formatSearchEvidenceLine,
  sanitizeSearchEvidencePinnedFilters,
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
  fingerprint: 'Fingerprint',
  pinned: 'Saved filters'
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
      fingerprint: '指纹',
      pinned: '保存的筛选'
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

describe('the pinned-filter attribution on a line', () => {
  it('names the saved filter set and repeats the filters it stood for', () => {
    const text = formatSearchEvidenceLine(
      {
        ...line,
        pinnedFilters: { name: 'Human mtDNA only', description: 'extensions=csv role=agent' }
      },
      labels
    )

    // The name on its own would not be checkable: the set can be edited after the capture, so the line has
    // to carry the filters the results were actually asked for.
    expect(text).toContain('Saved filters: Human mtDNA only (extensions=csv role=agent)')
    // ...and it sits above the fingerprint, which is what the reader checks the block against.
    expect(text.indexOf('Saved filters:')).toBeLessThan(text.indexOf('Fingerprint:'))
  })

  it('says nothing about filters when the capture had none applied', () => {
    expect(formatSearchEvidenceLine(line, labels)).not.toContain('Saved filters:')
  })

  it('drops an attribution that names a set without saying what it accepts', () => {
    expect(sanitizeSearchEvidencePinnedFilters({ name: 'only a name' })).toBeUndefined()
    expect(sanitizeSearchEvidencePinnedFilters({ description: 'only filters' })).toBeUndefined()
    expect(sanitizeSearchEvidencePinnedFilters('Human mtDNA only')).toBeUndefined()
    expect(sanitizeSearchEvidencePinnedFilters(undefined)).toBeUndefined()
  })

  it('trims a usable attribution and keeps both halves', () => {
    expect(
      sanitizeSearchEvidencePinnedFilters({
        name: '  Human mtDNA  ',
        description: ' extensions=csv '
      })
    ).toEqual({ name: 'Human mtDNA', description: 'extensions=csv' })
  })
})
