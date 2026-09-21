import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { SEARCH_EVIDENCE_HASH_RECIPE, type SearchEvidenceLine } from '../../shared/search-evidence'
import { createSearchEvidenceService, type SearchEvidencePorts } from './search-evidence'
import type { SearchableSessionMessage } from './global-search-service'

const message = (overrides: Partial<SearchableSessionMessage> = {}): SearchableSessionMessage => ({
  id: 'message-2',
  role: 'agent',
  timestamp: '2026-09-13T00:01:00.000Z',
  text: 'I wrote sin(x) values into replay_probe.csv',
  ...overrides
})

const harness = (
  messages: SearchableSessionMessage[] = [message()],
  onRead?: (sessionId: string) => Promise<SearchableSessionMessage[]>
): {
  service: ReturnType<typeof createSearchEvidenceService>
  ports: SearchEvidencePorts
} => {
  const ports: SearchEvidencePorts = {
    readSessionMessages: vi.fn(onRead ?? (async () => messages))
  }

  return { service: createSearchEvidenceService(ports), ports }
}

// Independent implementation of the published recipe: sha256 over recipe/sessionId/messageId/text,
// each line terminated by "\n" including the last.
const expectedFingerprint = (sessionId: string, messageId: string, text: string): string =>
  `sha256:${createHash('sha256')
    .update(`${SEARCH_EVIDENCE_HASH_RECIPE}\n${sessionId}\n${messageId}\n${text}`)
    .digest('hex')}`

describe('the saved filter set a capture was made under', () => {
  it('lands on the line together with the filters it stood for', async () => {
    const { service } = harness()

    const result = await service.capture({
      action: 'capture',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin csv',
      pinnedFilters: { name: 'Human mtDNA only', description: 'extensions=csv role=agent' }
    })

    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    expect(result.line.pinnedFilters).toEqual({
      name: 'Human mtDNA only',
      description: 'extensions=csv role=agent'
    })
  })

  it('leaves the fingerprint alone: the recipe covers the block, not the filters it was found under', async () => {
    const { service } = harness()
    const request = {
      action: 'capture' as const,
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin csv'
    }

    const plain = await service.capture(request)
    const attributed = await service.capture({
      ...request,
      pinnedFilters: { name: 'Human mtDNA only', description: 'extensions=csv' }
    })

    expect(plain.status).toBe('captured')
    expect(attributed.status).toBe('captured')
    if (plain.status !== 'captured' || attributed.status !== 'captured') return
    expect(attributed.line.fingerprint).toBe(plain.line.fingerprint)
  })

  it('drops an attribution that names a set without saying what it accepts', async () => {
    const { service } = harness()

    const result = await service.capture({
      action: 'capture',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin csv',
      pinnedFilters: { name: 'only a name', description: '   ' }
    })

    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    expect(result.line.pinnedFilters).toBeUndefined()
  })
})

describe('search evidence capture', () => {
  it('fingerprints the block as stored, with the recipe published in the contract', async () => {
    const { service } = harness()

    const result = await service.capture({
      action: 'capture',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin csv',
      terms: ['sin', 'csv'],
      capturedAt: '2026-09-14T10:00:00.000Z'
    })

    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    expect(result.line).toMatchObject({
      schemaVersion: 1,
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      role: 'agent',
      capturedAt: '2026-09-14T10:00:00.000Z',
      query: 'sin csv',
      terms: ['sin', 'csv'],
      snippet: 'I wrote sin(x) values into replay_probe.csv'
    })
    // A third party holding the block text can recompute this; the recipe is in the contract.
    expect(result.line.fingerprint).toBe(
      expectedFingerprint('session-a', 'message-2', message().text)
    )
  })

  it('uses the hit snippet when one is supplied but fingerprints the whole block', async () => {
    const { service } = harness()

    const result = await service.capture({
      action: 'capture',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin',
      snippet: '…sin(x) values…'
    })

    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    expect(result.line.snippet).toBe('…sin(x) values…')
    expect(result.line.terms).toEqual([])
    expect(result.line.fingerprint).toBe(
      expectedFingerprint('session-a', 'message-2', message().text)
    )
  })

  it('refuses a block whose stored text was truncated instead of fingerprinting a prefix', async () => {
    const { service } = harness([message({ truncated: true })])

    await expect(
      service.capture({
        action: 'capture',
        projectId: 'project-a',
        sessionId: 'session-a',
        messageId: 'message-2',
        query: 'sin'
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'text-truncated' })
  })

  it('names a missing block and an unreadable session', async () => {
    const missing = harness()
    await expect(
      missing.service.capture({
        action: 'capture',
        projectId: 'project-a',
        sessionId: 'session-a',
        messageId: 'message-404',
        query: 'sin'
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'message-not-found' })

    const unreadable = harness([], async () => {
      throw new Error('disk gone')
    })
    await expect(
      unreadable.service.capture({
        action: 'capture',
        projectId: 'project-a',
        sessionId: 'session-a',
        messageId: 'message-2',
        query: 'sin'
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'session-unavailable' })
  })
})

describe('search evidence verification', () => {
  const lineFor = async (): Promise<SearchEvidenceLine> => {
    const { service } = harness()
    const result = await service.capture({
      action: 'capture',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin'
    })
    if (result.status !== 'captured') throw new Error('capture failed')

    return result.line
  }

  it('verifies a line while the block still hashes the same', async () => {
    const line = await lineFor()
    const { service } = harness()

    await expect(service.verify(line)).resolves.toEqual({
      status: 'verified',
      fingerprint: line.fingerprint
    })
  })

  it('reports a changed block with the fingerprint it has now', async () => {
    const line = await lineFor()
    const { service } = harness([message({ text: 'edited after the citation was captured' })])

    const result = await service.verify(line)

    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toBe('fingerprint-mismatch')
    expect(result.fingerprintNow).toBe(
      expectedFingerprint('session-a', 'message-2', 'edited after the citation was captured')
    )
  })

  it('reports a block that is gone rather than claiming it verified', async () => {
    const line = await lineFor()
    const { service } = harness([])

    await expect(service.verify(line)).resolves.toEqual({
      status: 'unavailable',
      reason: 'message-not-found'
    })
  })
})

describe('search evidence dispatch', () => {
  it('routes by action', async () => {
    const { service } = harness()
    const captured = await service.handle({
      action: 'capture',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin'
    })
    expect(captured.status).toBe('captured')
    if (captured.status !== 'captured') return

    await expect(service.handle({ action: 'verify', line: captured.line })).resolves.toEqual({
      status: 'verified',
      fingerprint: captured.line.fingerprint
    })
  })
})
