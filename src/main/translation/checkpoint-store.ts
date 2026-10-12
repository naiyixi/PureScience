// Paragraph-level translation checkpoints: one file per source document, written atomically, read without
// ever throwing.
//
// The reason this is a store of *records* rather than a saved translation is honesty on resume: a record names
// the paragraph it came from and the hash of the source it was produced from, so a restarted run can prove a
// paragraph is unchanged before skipping it. Anything that cannot be proven is re-translated.
//
// The file name is a digest of the document identity, never the identity itself: ids come from callers (paths,
// doc ids) and a caller-supplied string must not be able to address a path outside the store root.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  TRANSLATION_RECORD_SCHEMA_VERSION,
  type TranslationRecord,
  type TranslationUnit
} from '../../shared/translation-units'

export const TRANSLATION_CHECKPOINT_DIR = 'translations'

/** What a checkpoint belongs to. `contentHash` catches a different document reusing an old id. */
export type TranslationSourceIdentity = {
  kind: string
  id: string
  contentHash: string
}

export type TranslationCheckpoint = {
  version: number
  source: TranslationSourceIdentity
  records: Record<string, TranslationRecord>
  updatedAt: number
}

export type TranslationCheckpointUnreadableReason =
  // The file exists but could not be read (permissions, I/O).
  | 'unreadable-file'
  // The file exists but is not JSON.
  | 'invalid-json'
  // JSON, but not a checkpoint this version can use.
  | 'invalid-shape'
  // Written by a different schema version: not guessed at.
  | 'wrong-version'

export type TranslationCheckpointLoad =
  | { state: 'absent' }
  | { state: 'ok'; checkpoint: TranslationCheckpoint; droppedRecordIds: string[] }
  | { state: 'unreadable'; reason: TranslationCheckpointUnreadableReason }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== ''

// A record is kept only when every field a resume decision depends on is present and of the right shape.
// A half-written record is dropped with its id reported, never repaired into something that looks reusable.
const sanitizeRecord = (id: string, value: unknown): TranslationRecord | null => {
  if (!isRecord(value)) return null
  const status = value.status
  if (status !== 'translated' && status !== 'failed') return null
  if (!isNonEmptyString(value.sourceHash)) return null
  if (typeof value.page !== 'number' || !Number.isInteger(value.page) || value.page < 1) return null
  if (typeof value.updatedAt !== 'number') return null
  if (status === 'translated' && !isNonEmptyString(value.text)) return null
  return {
    id,
    page: value.page,
    sourceHash: value.sourceHash,
    status,
    ...(status === 'translated' ? { text: value.text as string } : {}),
    ...(isNonEmptyString(value.reason) ? { reason: value.reason } : {}),
    updatedAt: value.updatedAt
  }
}

const sanitizeIdentity = (value: unknown): TranslationSourceIdentity | null => {
  if (!isRecord(value)) return null
  if (!isNonEmptyString(value.kind)) return null
  if (!isNonEmptyString(value.id)) return null
  if (typeof value.contentHash !== 'string') return null
  return { kind: value.kind, id: value.id, contentHash: value.contentHash }
}

export type TranslationCheckpointStoreOptions = {
  /** The store's own directory; the caller owns where it lives (a data root, a test's temp dir). */
  root: string
  now?: () => number
}

export class TranslationCheckpointStore {
  private readonly now: () => number

  constructor(private readonly options: TranslationCheckpointStoreOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  private directory(): string {
    return join(this.options.root, TRANSLATION_CHECKPOINT_DIR)
  }

  /** The file this source's checkpoint would live in. Exposed so a report can name where a reading came from. */
  pathFor(source: Pick<TranslationSourceIdentity, 'kind' | 'id'>): string {
    const digest = createHash('sha256')
      .update(`${source.kind}\u0000${source.id}`, 'utf8')
      .digest('hex')
    return join(this.directory(), `${digest.slice(0, 32)}.json`)
  }

  async read(source: TranslationSourceIdentity): Promise<TranslationCheckpointLoad> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(source), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
      return { state: 'unreadable', reason: 'unreadable-file' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { state: 'unreadable', reason: 'invalid-json' }
    }

    if (!isRecord(parsed)) return { state: 'unreadable', reason: 'invalid-shape' }
    if (parsed.version !== TRANSLATION_RECORD_SCHEMA_VERSION) {
      return { state: 'unreadable', reason: 'wrong-version' }
    }
    const identity = sanitizeIdentity(parsed.source)
    if (!identity) return { state: 'unreadable', reason: 'invalid-shape' }
    if (
      typeof parsed.records !== 'object' ||
      parsed.records === null ||
      Array.isArray(parsed.records)
    ) {
      return { state: 'unreadable', reason: 'invalid-shape' }
    }

    const records: Record<string, TranslationRecord> = {}
    const droppedRecordIds: string[] = []
    for (const [id, value] of Object.entries(parsed.records as Record<string, unknown>)) {
      const record = sanitizeRecord(id, value)
      if (record) records[id] = record
      else droppedRecordIds.push(id)
    }
    droppedRecordIds.sort()

    return {
      state: 'ok',
      checkpoint: {
        version: TRANSLATION_RECORD_SCHEMA_VERSION,
        source: identity,
        records,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : this.now()
      },
      droppedRecordIds
    }
  }

  /**
   * Writes the checkpoint atomically: a partially written file is never observable, so a crash mid-write leaves
   * the previous checkpoint (or nothing) rather than a file that reads as an empty translation set.
   */
  async write(
    source: TranslationSourceIdentity,
    records: Record<string, TranslationRecord>
  ): Promise<void> {
    const target = this.pathFor(source)
    await mkdir(dirname(target), { recursive: true })
    const checkpoint: TranslationCheckpoint = {
      version: TRANSLATION_RECORD_SCHEMA_VERSION,
      source,
      records,
      updatedAt: this.now()
    }
    const temp = `${target}.${createHash('sha256').update(String(this.now())).digest('hex').slice(0, 8)}.tmp`
    try {
      await writeFile(temp, JSON.stringify(checkpoint), { encoding: 'utf8', flag: 'wx' })
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}

/**
 * Whether a loaded checkpoint describes the source in hand. Three ways to fail, each named, and none of them
 * may be read as "nothing changed": a checkpoint for another document, or for other content under the same id,
 * is discarded and the document is translated again from its own current text.
 */
export type TranslationCheckpointApplicability =
  | { applies: true }
  | { applies: false; reason: 'source-document-changed' | 'source-content-changed' }

export const checkpointAppliesTo = (
  checkpoint: { source: TranslationSourceIdentity },
  source: TranslationSourceIdentity
): TranslationCheckpointApplicability => {
  if (checkpoint.source.kind !== source.kind || checkpoint.source.id !== source.id) {
    return { applies: false, reason: 'source-document-changed' }
  }
  if (checkpoint.source.contentHash !== source.contentHash) {
    return { applies: false, reason: 'source-content-changed' }
  }
  return { applies: true }
}

/** The source identity's content fingerprint: over the page texts in page order, so reordering is a change. */
export const translationSourceContentHash = (pages: readonly string[]): string =>
  createHash('sha256')
    .update(pages.map((page) => `${page.length}\u0000${page}`).join('\u0001'), 'utf8')
    .digest('hex')

/** Convenience for callers that hold units rather than pages (used by the service layer). */
export const translationRecordKey = (unit: TranslationUnit): string => unit.id
