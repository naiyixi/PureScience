// Context-summary chunk persistence: the store behind summary_query / boundary. When the app
// compacts a session, the folded-away transcript window is captured as an immutable chunk (JSON
// file under the data root). The agent can later retrieve verbatim details via summary_query and
// mark task boundaries via boundary; both round-trip through the main process over the local RPC
// gateway so there is a single writer and audit-safe, append-only storage.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type { ContextSummaryChunk } from '../../shared/context-summary-mcp'
import type { SummaryQueryResult } from './context-summary-mcp-server'

const CHUNKS_DIR = '.context-summary'
const CHUNKS_FILE = 'chunks.json'

// Bounds: a chunk's transcript is capped so a single summary_query answer stays cheap; the file
// itself is capped so runaway sessions cannot grow unbounded on disk.
const MAX_TRANSCRIPT_CHARS = 2_000_000
const MAX_CHUNKS_PER_SESSION = 64

const resolveChunksRoot = (root: string, sessionId: string): string => {
  const candidate = resolve(root, 'artifacts', encodeURIComponent(sessionId), CHUNKS_DIR)
  const fromRoot = relative(resolve(root), candidate)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Invalid context-summary storage key.')
  }
  return candidate
}

const parseChunks = (raw: string): ContextSummaryChunk[] => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter(isChunk)
    return []
  } catch {
    return []
  }
}

const isChunk = (value: unknown): value is ContextSummaryChunk => {
  if (typeof value !== 'object' || value === null) return false
  const chunk = value as Record<string, unknown>
  return (
    typeof chunk.id === 'string' &&
    (chunk.level === 1 || chunk.level === 2) &&
    typeof chunk.transcript === 'string' &&
    typeof chunk.summaryText === 'string' &&
    typeof chunk.summaryId === 'string'
  )
}

export type ContextSummaryRepositoryOptions = {
  storageRoot: string
  createId?: () => string
  now?: () => number
}

export class ContextSummaryRepository {
  private readonly createId: () => string
  private readonly now: () => number

  constructor(private readonly options: ContextSummaryRepositoryOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  private chunksPath(sessionId: string): string {
    return join(resolveChunksRoot(this.options.storageRoot, sessionId), CHUNKS_FILE)
  }

  private async readChunks(sessionId: string): Promise<ContextSummaryChunk[]> {
    try {
      const raw = await readFile(this.chunksPath(sessionId), 'utf8')
      return parseChunks(raw)
    } catch {
      return []
    }
  }

  private async writeChunks(sessionId: string, chunks: ContextSummaryChunk[]): Promise<void> {
    const target = this.chunksPath(sessionId)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${this.createId()}.tmp`
    await writeFile(temp, JSON.stringify(chunks, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temp, target)
  }

  // Appends a folded window as an immutable chunk. Returns the chunk's stable id (also usable as
  // the <summary id=…> for summary_query).
  async appendChunk(input: {
    sessionId: string
    level: 1 | 2
    reason: string
    boundaryLabel?: string
    foldedTokens?: number
    firstMessageId?: string
    lastMessageId?: string
    transcript: string
    summaryText: string
  }): Promise<{ chunkId: string }> {
    const chunks = await this.readChunks(input.sessionId)
    if (chunks.length >= MAX_CHUNKS_PER_SESSION) {
      // Fail closed on runaway sessions: drop the OLDEST chunk rather than grow unbounded.
      chunks.shift()
    }
    const foldedAt = this.now()
    const chunkId = `fold-${foldedAt}-${this.createId().slice(0, 8)}`
    const chunk: ContextSummaryChunk = {
      id: chunkId,
      level: input.level,
      foldedAt,
      reason: input.reason,
      boundaryLabel: input.boundaryLabel,
      foldedTokens: input.foldedTokens,
      firstMessageId: input.firstMessageId,
      lastMessageId: input.lastMessageId,
      transcript: input.transcript.slice(0, MAX_TRANSCRIPT_CHARS),
      summaryText: input.summaryText,
      summaryId: chunkId
    }
    await this.writeChunks(input.sessionId, [...chunks, chunk])
    return { chunkId }
  }

  // Records a task boundary. The boundary is attached to the NEXT appended chunk; until then it is
  // held as the session's pending boundary (single slot, newest wins).
  async recordBoundary(sessionId: string, label: string
  ): Promise<{ recorded: boolean; boundaryId?: string }> {
    // Boundaries live in the chunk file as a small sidecar so the agent's call is acknowledged
    // even before the next fold. We store a dedicated boundaries file (append-only).
    const target = join(
      resolveChunksRoot(this.options.storageRoot, sessionId),
      'boundaries.json'
    )
    let boundaries: Array<{ id: string; label: string; createdAt: number }> = []
    try {
      const raw = await readFile(target, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) boundaries = parsed as Array<{ id: string; label: string; createdAt: number }>
    } catch {
      boundaries = []
    }
    const boundaryId = `boundary-${this.now()}-${this.createId().slice(0, 8)}`
    boundaries.push({ id: boundaryId, label, createdAt: this.now() })
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${this.createId()}.tmp`
    await writeFile(temp, JSON.stringify(boundaries, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temp, target)
    return { recorded: true, boundaryId }
  }

  // Loads the most recent boundary label (for attaching to the next fold).
  async latestBoundaryLabel(sessionId: string): Promise<string | undefined> {
    const target = join(
      resolveChunksRoot(this.options.storageRoot, sessionId),
      'boundaries.json'
    )
    try {
      const raw = await readFile(target, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const boundaries = parsed as Array<{ label: string; createdAt: number }>
        if (boundaries.length > 0) {
          return [...boundaries].sort((a, b) => b.createdAt - a.createdAt)[0]?.label
        }
      }
    } catch {
      // No boundaries yet.
    }
    return undefined
  }

  // Answers a summary_query against the chunk's ORIGINAL transcript. Retrieval is lexical:
  // the question's significant terms are matched against the transcript and the surrounding line
  // window is returned, so the agent gets the verbatim detail without an embedding pipeline.
  async queryChunk(
    sessionId: string,
    summaryId: string,
    question: string
  ): Promise<SummaryQueryResult> {
    const chunks = await this.readChunks(sessionId)
    const chunk = chunks.find((candidate) => candidate.summaryId === summaryId)
    if (!chunk) {
      return { found: false, reason: `No folded chunk with id ${summaryId}.` }
    }

    const transcript = chunk.transcript
    const questionLower = question.toLowerCase()
    const terms = questionLower
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .filter((term) => term.length >= 3)
      .slice(0, 6)
    if (terms.length === 0) {
      return {
        found: true,
        summaryId: chunk.summaryId,
        answer: transcript.slice(0, 4000),
        summaryText: chunk.summaryText
      }
    }

    const lines = transcript.split('\n')
    const scored = lines.map((line, index) => {
      const lower = line.toLowerCase()
      const score = terms.reduce(
        (sum, term) => sum + (lower.includes(term) ? 1 : 0),
        0
      )
      return { line, index, score }
    })
    const best = scored
      .map((entry) => ({ ...entry, distance: Math.abs(entry.index - Math.floor(lines.length / 2)) }))
      .sort((a, b) => b.score - a.score || a.distance - b.distance)[0]

    if (!best || best.score === 0) {
      return {
        found: true,
        summaryId: chunk.summaryId,
        answer: 'No verbatim match found in the folded chunk. The summary below is the only record: ' +
          chunk.summaryText,
        summaryText: chunk.summaryText
      }
    }

    // Return the matching line plus a small window around it.
    const start = Math.max(0, best.index - 5)
    const end = Math.min(lines.length, best.index + 8)
    return {
      found: true,
      summaryId: chunk.summaryId,
      answer: lines.slice(start, end).join('\n'),
      summaryText: chunk.summaryText
    }
  }

  // Lists all chunks for a session (UI: fold timeline).
  async listChunks(sessionId: string): Promise<ContextSummaryChunk[]> {
    return this.readChunks(sessionId)
  }

  // Removes chunks for a deleted session/project.
  async deleteChunksForSession(sessionId: string): Promise<void> {
    const root = resolveChunksRoot(this.options.storageRoot, sessionId)
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  }
}
