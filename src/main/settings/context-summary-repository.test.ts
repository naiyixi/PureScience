// Integration test for the context-summary repository (chunk persistence + lexical query +
// boundary recording) against a real temp filesystem.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ContextSummaryRepository } from './context-summary-repository'

let root: string | undefined
let seq = 0

const createRepository = async (): Promise<ContextSummaryRepository> => {
  root = await mkdtemp(join(tmpdir(), 'purescience-context-summary-'))
  return new ContextSummaryRepository({
    storageRoot: root,
    createId: () => `id-${++seq}`,
    now: () => 1_700_000_000_000 + seq
  })
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

const transcript = [
  '[user] Filter EGFR variants for T790M',
  '[assistant] Querying gnomAD for variant 19:41228202 A>C (T790M)',
  '[tool_result] Found 3 records; population frequency 0.012%',
  '[assistant] The T790M variant frequency is approximately 0.012% in gnomAD r4.'
].join('\n')

describe('ContextSummaryRepository', () => {
  it('appends and lists chunks with stable ids', async () => {
    const repo = await createRepository()
    const { chunkId } = await repo.appendChunk({
      sessionId: 'session-1',
      level: 1,
      reason: 'automatic',
      transcript,
      summaryText: 'Context compacted (automatic).'
    })

    expect(chunkId).toMatch(/^fold-/)
    const chunks = await repo.listChunks('session-1')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.id).toBe(chunkId)
    expect(chunks[0]!.summaryId).toBe(chunkId)
    expect(chunks[0]!.level).toBe(1)
    expect(chunks[0]!.reason).toBe('automatic')
    expect(chunks[0]!.transcript).toContain('T790M')
  })

  it('answers summary_query with the verbatim matching window', async () => {
    const repo = await createRepository()
    const { chunkId } = await repo.appendChunk({
      sessionId: 'session-1',
      level: 1,
      reason: 'manual',
      transcript,
      summaryText: 'Context compacted (manual).'
    })

    const result = await repo.queryChunk('session-1', chunkId, 'what is the T790M frequency?')
    expect(result.found).toBe(true)
    expect(result.answer).toContain('0.012%')
    // The answer is a window around the best matching line, not the whole transcript; with a
    // longer transcript the window excludes lines far from the match.
    expect(result.answer!.length).toBeLessThanOrEqual(transcript.length)
    expect(result.summaryText).toBe('Context compacted (manual).')
  })

  it('reports not-found for an unknown summary id', async () => {
    const repo = await createRepository()
    const result = await repo.queryChunk('session-1', 'fold-missing', 'anything')
    expect(result.found).toBe(false)
    expect(result.reason).toContain('No folded chunk')
  })

  it('falls back to the chunk summary when no term matches', async () => {
    const repo = await createRepository()
    const { chunkId } = await repo.appendChunk({
      sessionId: 'session-1',
      level: 1,
      reason: 'automatic',
      transcript,
      summaryText: 'Summary says the allele frequency was reported.'
    })
    const result = await repo.queryChunk('session-1', chunkId, 'zzzzz')
    expect(result.found).toBe(true)
    expect(result.answer).toContain('Summary says')
  })

  it('records boundaries and surfaces the latest as the next fold label', async () => {
    const repo = await createRepository()
    const first = await repo.recordBoundary('session-1', 'finished variant filtering')
    expect(first.recorded).toBe(true)
    await repo.recordBoundary('session-1', 'started structure analysis')

    const label = await repo.latestBoundaryLabel('session-1')
    expect(label).toBe('started structure analysis')

    // The caller (context-summary capture) reads the latest boundary and passes it to appendChunk;
    // verify the label is persisted on the chunk when provided.
    const { chunkId } = await repo.appendChunk({
      sessionId: 'session-1',
      level: 1,
      reason: 'automatic',
      boundaryLabel: label,
      transcript,
      summaryText: 'folded'
    })
    const chunks = await repo.listChunks('session-1')
    expect(chunks[0]!.boundaryLabel).toBe('started structure analysis')
    expect(chunks[0]!.id).toBe(chunkId)
  })

  it('caps chunks per session by dropping the oldest', async () => {
    const repo = await createRepository()
    // Append 66 chunks (cap is 64): oldest should be dropped.
    for (let i = 0; i < 66; i += 1) {
      await repo.appendChunk({
        sessionId: 'session-1',
        level: 1,
        reason: 'automatic',
        transcript: `chunk ${i}`,
        summaryText: `summary ${i}`
      })
    }
    const chunks = await repo.listChunks('session-1')
    expect(chunks).toHaveLength(64)
    expect(chunks[0]!.transcript).toBe('chunk 2')
  })

  it('deletes chunks for a session', async () => {
    const repo = await createRepository()
    await repo.appendChunk({
      sessionId: 'session-1',
      level: 1,
      reason: 'automatic',
      transcript,
      summaryText: 'folded'
    })
    await repo.deleteChunksForSession('session-1')
    expect(await repo.listChunks('session-1')).toEqual([])
  })

  it('writes chunks as valid JSON files on disk', async () => {
    const repo = await createRepository()
    await repo.appendChunk({
      sessionId: 'session-1',
      level: 1,
      reason: 'automatic',
      transcript,
      summaryText: 'folded'
    })
    const chunksFile = join(root!, 'artifacts', 'session-1', '.context-summary', 'chunks.json')
    const raw = await readFile(chunksFile, 'utf8')
    const parsed = JSON.parse(raw) as Array<{ id: string; transcript: string }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.transcript).toContain('T790M')
  })
})
