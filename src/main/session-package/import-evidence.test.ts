import { describe, expect, it, vi } from 'vitest'

import type { CreateReferenceInput } from '../../shared/references'
import type { CreateReviewInput, NewCheck } from '../../shared/reviewer'
import type { SearchEvidenceCaptureResult, SearchEvidenceLine } from '../../shared/search-evidence'
import { landImportedEvidence, type ImportedEvidencePorts } from './import-evidence'

const line: SearchEvidenceLine = {
  schemaVersion: 1,
  projectId: 'target-project',
  sessionId: 'new-session',
  messageId: 'm1',
  role: 'user',
  capturedAt: '2026-10-04T00:00:00.000Z',
  query: '对接',
  terms: ['对接'],
  snippet: '模拟一下分子对接',
  fingerprint: 'sha256:recomputed-here'
}

type Harness = {
  ports: ImportedEvidencePorts
  created: Array<CreateReferenceInput & { citationKey: string }>
  reviews: CreateReviewInput[]
  findings: Array<{ reviewId: string; findings: readonly NewCheck[] }>
  appended: Array<Parameters<ImportedEvidencePorts['appendReviewEvidence']>[0]>
}

const harness = (options?: {
  takenKeys?: readonly string[]
  createReferenceFails?: boolean
  capture?: SearchEvidenceCaptureResult
  appendFails?: boolean
  createReviewFails?: boolean
}): Harness => {
  const created: Harness['created'] = []
  const reviews: CreateReviewInput[] = []
  const findings: Harness['findings'] = []
  const appended: Harness['appended'] = []
  const ports: ImportedEvidencePorts = {
    listReferenceKeys: async (): Promise<readonly string[]> => options?.takenKeys ?? [],
    createReference: async (input): Promise<unknown> => {
      if (options?.createReferenceFails) throw new Error('duplicate key')
      created.push(input)
      return undefined
    },
    createReview: async (input): Promise<{ id: string }> => {
      if (options?.createReviewFails) throw new Error('review store offline')
      reviews.push(input)
      return { id: `new-review-${reviews.length}` }
    },
    addFindings: async (reviewId, checks): Promise<void> => {
      findings.push({ reviewId, findings: checks })
    },
    captureEvidence: async (): Promise<SearchEvidenceCaptureResult> =>
      options?.capture ?? { status: 'captured', line },
    appendReviewEvidence: async (input): Promise<unknown> => {
      if (options?.appendFails) throw new Error('pin store offline')
      appended.push(input)
      return undefined
    }
  }
  return { ports, created, reviews, findings, appended }
}

const base = {
  targetProjectId: 'target-project',
  sessionId: 'new-session',
  messageIds: ['m1', 'm2'],
  citations: [] as readonly unknown[],
  reviewFindings: [] as readonly unknown[],
  verificationRecords: [] as readonly unknown[]
}

const citationRow = {
  id: 'ref-1',
  projectId: 'source-project',
  title: 'Molecular docking of nirmatrelvir',
  authors: [{ name: 'Zhang', orcid: '0000-0002-1825-0097' }, { name: 'Li' }],
  venue: 'Nature Communications',
  year: 2023,
  volume: '14',
  issue: '1',
  pages: '1-9',
  doi: '10.1000/xyz',
  sourceConnector: 'openalex',
  citationKey: 'Zhang2023',
  provenance: { connector: 'openalex', fetchedAt: '2026-09-01T00:00:00.000Z' },
  // Pointers that only mean something on the sending machine.
  pdfManagedFileId: 'mf-1',
  journalId: 'journal-1'
}

const reviewRow = {
  id: 'source-review-1',
  projectId: 'source-project',
  sessionId: 'source-session',
  turnMessageId: 'm1',
  scope: {
    turnMessageId: 'm1',
    blocks: [{ id: 'b1', kind: 'message', sourceId: 'm1', blockIndex: 0, contentHash: 'h1' }],
    artifactVersionIds: ['version-1']
  },
  lifecycle: 'complete',
  outcome: 'flagged',
  model: 'claude-opus-4-5',
  reviewerLog: [
    { kind: 'thought', text: 'checked the claim' },
    { kind: 'tool', toolName: 'read_turn' }
  ],
  checks: [
    {
      status: 'warn',
      claim: 'The 4.5 Å box is smaller than the ligand',
      evidence: 'box size in the script',
      locator: { blockRef: 'b1' },
      artifactVersionId: 'version-1',
      resolution: 'open',
      sortIndex: 0
    }
  ]
}

const verificationRow = {
  schemaVersion: 1,
  id: 'pin-1',
  reviewId: 'source-review-1',
  projectId: 'source-project',
  sessionId: 'source-session',
  messageId: 'm1',
  role: 'user',
  // The SENDER's fingerprint. It was computed over the sender's session id, so it can never verify here.
  fingerprint: 'sha256:sender-machine',
  query: '对接',
  terms: ['对接'],
  snippet: '模拟一下分子对接',
  capturedAt: '2026-09-20T00:00:00.000Z'
}

describe('landing a package’s evidence', () => {
  it('lands citations in the target project without the sender’s machine-local pointers', async () => {
    const test = harness()
    const landed = await landImportedEvidence(test.ports, { ...base, citations: [citationRow] })

    expect(landed.citations).toBe(1)
    expect(landed.skipped).toEqual([])
    const created = test.created[0]
    expect(created.projectId).toBe('target-project')
    expect(created.citationKey).toBe('Zhang2023')
    expect(created.title).toBe('Molecular docking of nirmatrelvir')
    expect(created.authors).toEqual([
      { name: 'Zhang', orcid: '0000-0002-1825-0097' },
      { name: 'Li' }
    ])
    expect(created.year).toBe(2023)
    expect(created.doi).toBe('10.1000/xyz')
    expect(created.provenance).toEqual({
      connector: 'openalex',
      fetchedAt: '2026-09-01T00:00:00.000Z'
    })
    // The sender's managed file and journal id are the sender's: neither is carried.
    expect(created).not.toHaveProperty('pdfManagedFileId')
    expect(created).not.toHaveProperty('journalId')
  })

  it('refuses a citation key the target project already uses, by name', async () => {
    const test = harness({ takenKeys: ['Zhang2023'] })
    const landed = await landImportedEvidence(test.ports, { ...base, citations: [citationRow] })

    expect(landed.citations).toBe(0)
    expect(landed.skipped).toEqual([
      { kind: 'citations', reason: 'reference-key-taken', id: 'Zhang2023' }
    ])
    expect(test.created).toEqual([])
  })

  it('refuses a citation row that is not the shape its kind requires', async () => {
    const test = harness()
    const landed = await landImportedEvidence(test.ports, {
      ...base,
      citations: [{ citationKey: 'NoTitle' }, 'not-a-row']
    })

    expect(landed.citations).toBe(0)
    expect(landed.skipped).toEqual([
      { kind: 'citations', reason: 'row-unreadable', id: 'NoTitle' },
      { kind: 'citations', reason: 'row-unreadable' }
    ])
  })

  it('lands the reviewer’s findings unbound, and re-roots the audited window here', async () => {
    const test = harness()
    const landed = await landImportedEvidence(test.ports, {
      ...base,
      reviewFindings: [reviewRow]
    })

    expect(landed.reviews).toBe(1)
    expect(landed.reviewFindings).toBe(1)
    expect(landed.skipped).toEqual([])
    const review = test.reviews[0]
    expect(review.projectId).toBe('target-project')
    expect(review.sessionId).toBe('new-session')
    expect(review.turnMessageId).toBe('m1')
    expect(review.lifecycle).toBe('complete')
    expect(review.outcome).toBe('flagged')
    expect(review.model).toBe('claude-opus-4-5')
    expect(review.reviewerLog).toEqual([
      { kind: 'thought', text: 'checked the claim' },
      { kind: 'tool', toolName: 'read_turn' }
    ])
    // Artifact version ids name the sender's versions, so the scope carries none of them.
    expect(review.scope.artifactVersionIds).toEqual([])
    expect(review.scope.blocks).toEqual([
      { id: 'b1', kind: 'message', sourceId: 'm1', blockIndex: 0, contentHash: 'h1' }
    ])
    // The finding keeps the sender's claim verbatim, and is NOT bound to an artifact version here.
    expect(test.findings[0].reviewId).toBe('new-review-1')
    expect(test.findings[0].findings).toEqual([
      {
        status: 'warn',
        claim: 'The 4.5 Å box is smaller than the ligand',
        evidence: 'box size in the script',
        locator: { blockRef: 'b1' },
        resolution: 'open',
        sortIndex: 0
      }
    ])
    expect(test.findings[0].findings[0]).not.toHaveProperty('artifactVersionId')
  })

  it('refuses a review whose turn is not in the imported transcript', async () => {
    const test = harness()
    const landed = await landImportedEvidence(test.ports, {
      ...base,
      reviewFindings: [{ ...reviewRow, turnMessageId: 'm-elsewhere' }]
    })

    expect(landed.reviews).toBe(0)
    expect(landed.skipped).toEqual([
      { kind: 'review-findings', reason: 'message-not-found', id: 'source-review-1' }
    ])
    expect(test.reviews).toEqual([])
  })

  it('counts a malformed check as a row that did not land, and still lands the review', async () => {
    const test = harness()
    const landed = await landImportedEvidence(test.ports, {
      ...base,
      reviewFindings: [
        { ...reviewRow, checks: [reviewRow.checks[0], { status: 'maybe', claim: '' }] }
      ]
    })

    expect(landed.reviews).toBe(1)
    expect(landed.reviewFindings).toBe(1)
    expect(landed.skipped).toEqual([
      { kind: 'review-findings', reason: 'row-unreadable', id: 'source-review-1' }
    ])
  })

  // The pin's whole value is that whoever reads it can recompute the fingerprint. The sender's cannot be
  // recomputed here (it was hashed over the sender's session id), so it is never stored: the app derives
  // a new one from the block as THIS machine holds it.
  it('stores a pin with the fingerprint this machine derives, never the sender’s', async () => {
    const test = harness()
    const landed = await landImportedEvidence(test.ports, {
      ...base,
      reviewFindings: [reviewRow],
      verificationRecords: [verificationRow]
    })

    expect(landed.verificationRecords).toBe(1)
    expect(landed.skipped).toEqual([])
    const pin = test.appended[0]
    expect(pin.reviewId).toBe('new-review-1')
    expect(pin.projectId).toBe('target-project')
    expect(pin.sessionId).toBe('new-session')
    expect(pin.fingerprint).toBe('sha256:recomputed-here')
    expect(pin.fingerprint).not.toBe('sha256:sender-machine')
    expect(pin.role).toBe('user')
    expect(pin.snippet).toBe('模拟一下分子对接')
    // The query and the moment of capture are the sender's record of how the block was found.
    expect(pin.query).toBe('对接')
    expect(pin.terms).toEqual(['对接'])
    expect(pin.capturedAt).toEqual(new Date('2026-09-20T00:00:00.000Z'))
  })

  it('refuses a pin whose review did not land', async () => {
    const test = harness()
    const landed = await landImportedEvidence(test.ports, {
      ...base,
      reviewFindings: [{ ...reviewRow, turnMessageId: 'm-elsewhere' }],
      verificationRecords: [verificationRow]
    })

    expect(landed.verificationRecords).toBe(0)
    expect(landed.skipped).toContainEqual({
      kind: 'verifications',
      reason: 'review-not-imported',
      id: 'source-review-1'
    })
  })

  it('names the reason a pin could not be re-derived against the transcript', async () => {
    const test = harness({ capture: { status: 'unavailable', reason: 'message-not-found' } })
    const landed = await landImportedEvidence(test.ports, {
      ...base,
      reviewFindings: [reviewRow],
      verificationRecords: [verificationRow]
    })

    expect(landed.verificationRecords).toBe(0)
    expect(landed.skipped).toEqual([
      { kind: 'verifications', reason: 'message-not-found', id: 'source-review-1' }
    ])
    expect(test.appended).toEqual([])
  })

  // A store that refuses a write is named, never swallowed, and never stops the rows that can land.
  it('keeps going when the store refuses one row', async () => {
    const test = harness({ createReferenceFails: true, appendFails: true })
    const landed = await landImportedEvidence(test.ports, {
      ...base,
      citations: [citationRow],
      reviewFindings: [reviewRow],
      verificationRecords: [verificationRow]
    })

    expect(landed.citations).toBe(0)
    expect(landed.reviews).toBe(1)
    expect(landed.verificationRecords).toBe(0)
    expect(landed.skipped).toEqual([
      { kind: 'citations', reason: 'landing-failed', id: 'Zhang2023' },
      { kind: 'verifications', reason: 'landing-failed', id: 'source-review-1' }
    ])
  })

  it('still attempts a citation when the list of taken keys cannot be read', async () => {
    const test = harness()
    test.ports.listReferenceKeys = vi.fn(async (): Promise<readonly string[]> => {
      throw new Error('store offline')
    })
    const landed = await landImportedEvidence(test.ports, { ...base, citations: [citationRow] })

    // The key list is a convenience; the store's own unique key is what actually decides. So the row is
    // attempted anyway, and a collision is reported by name instead of the whole kind being written off.
    expect(landed.citations).toBe(1)
    expect(landed.skipped).toEqual([])
  })
})
