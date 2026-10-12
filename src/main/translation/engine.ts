// The translation run: what to send, what to skip, and what a restart is allowed to believe.
//
// Two properties this module exists to guarantee:
//   1. A paragraph is only ever skipped when a stored translation proves it came from the same bytes.
//   2. A unit is only ever recorded as translated when the translator returned text. An empty answer is a
//      failure with a name, never a translation that would render as a blank line.
//
// The checkpoint is written after every unit, so an interruption (a crash, a quit, a cancellation) costs at
// most the unit in flight and the next run resumes from the same records.

import { createHash } from 'node:crypto'

import {
  planTranslation,
  translationSourceHashInput,
  type TranslationRecord,
  type TranslationUnit
} from '../../shared/translation-units'
import {
  checkpointAppliesTo,
  type TranslationCheckpointStore,
  type TranslationCheckpointUnreadableReason,
  type TranslationSourceIdentity
} from './checkpoint-store'

/** The digest of a unit's source, over the published recipe input. Computed here: the shared layer has no crypto. */
export const translationSourceHash = (unit: TranslationUnit): string =>
  createHash('sha256').update(translationSourceHashInput(unit.id, unit.text), 'utf8').digest('hex')

export type TranslateOutcome = { ok: true; text: string } | { ok: false; reason: string }

export type TranslationTranslator = (unit: TranslationUnit) => Promise<TranslateOutcome>

/** Stops a run that is only producing failures, so a broken provider does not burn through a whole document. */
export const TRANSLATION_MAX_CONSECUTIVE_FAILURES = 3

export type TranslationProgress = {
  total: number
  translated: number
  reused: number
  failed: number
  unitId: string
}

/** Why a run stopped before its plan was exhausted. Absent when every planned unit was attempted. */
export type TranslationStopReason = 'requested' | 'repeated-failures'

/** What the run found on disk beforehand. Named, so "no translation yet" is never confused with "read failed". */
export type TranslationRestoredState =
  | {
      state: 'none'
      reason: 'no-checkpoint' | 'source-document-changed' | 'source-content-changed'
    }
  | { state: 'none'; reason: 'unreadable'; detail: TranslationCheckpointUnreadableReason }
  | { state: 'partial'; records: number; droppedRecordIds: string[] }

export type TranslationRunResult = {
  restored: TranslationRestoredState
  total: number
  translated: number
  reused: number
  failed: { id: string; reason: string }[]
  /** Units the plan wanted but the run never reached (because it stopped). */
  skipped: number
  stopped: TranslationStopReason | null
  /** Where the records live — reported so a reading can name the file it was taken from. */
  checkpointPath: string
}

export type TranslationRunOptions = {
  source: TranslationSourceIdentity
  units: readonly TranslationUnit[]
  store: TranslationCheckpointStore
  translate: TranslationTranslator
  /** Consulted before each unit: a run is expected to be interruptible. */
  shouldStop?: () => boolean
  maxConsecutiveFailures?: number
  onProgress?: (progress: TranslationProgress) => void
}

export const runTranslation = async ({
  source,
  units,
  store,
  translate,
  shouldStop,
  maxConsecutiveFailures = TRANSLATION_MAX_CONSECUTIVE_FAILURES,
  onProgress
}: TranslationRunOptions): Promise<TranslationRunResult> => {
  const checkpointPath = store.pathFor(source)
  const loaded = await store.read(source)

  let records: Record<string, TranslationRecord> = {}
  let restored: TranslationRestoredState

  if (loaded.state === 'absent') {
    restored = { state: 'none', reason: 'no-checkpoint' }
  } else if (loaded.state === 'unreadable') {
    restored = { state: 'none', reason: 'unreadable', detail: loaded.reason }
  } else {
    const applicable = checkpointAppliesTo(loaded.checkpoint, source)
    if (!applicable.applies) {
      restored = { state: 'none', reason: applicable.reason }
    } else {
      records = loaded.checkpoint.records
      restored = {
        state: 'partial',
        records: Object.keys(records).length,
        droppedRecordIds: loaded.droppedRecordIds
      }
    }
  }

  const plan = planTranslation([...units], records, translationSourceHash)
  // Only records for the units in this plan are carried forward: a record whose paragraph is gone would
  // otherwise claim a translation of text that no longer exists.
  const kept: Record<string, TranslationRecord> = {}
  for (const id of plan.reused) {
    const record = records[id]
    if (record) kept[id] = record
  }

  const failed: { id: string; reason: string }[] = []
  let translated = 0
  let consecutiveFailures = 0
  let skipped = 0
  let stopped: TranslationStopReason | null = null

  const persist = async (): Promise<void> => {
    await store.write(source, kept)
  }

  if (plan.removed.length > 0) await persist()

  for (const entry of plan.toTranslate) {
    if (shouldStop?.()) {
      stopped = 'requested'
      break
    }

    const outcome = await translate(entry.unit)
    const now = Date.now()
    if (outcome.ok && outcome.text.trim() !== '') {
      kept[entry.unit.id] = {
        id: entry.unit.id,
        page: entry.unit.page,
        sourceHash: translationSourceHash(entry.unit),
        status: 'translated',
        text: outcome.text,
        updatedAt: now
      }
      translated += 1
      consecutiveFailures = 0
    } else {
      const reason = outcome.ok ? 'empty-translation' : outcome.reason
      kept[entry.unit.id] = {
        id: entry.unit.id,
        page: entry.unit.page,
        sourceHash: translationSourceHash(entry.unit),
        status: 'failed',
        reason,
        updatedAt: now
      }
      failed.push({ id: entry.unit.id, reason })
      consecutiveFailures += 1
    }

    await persist()
    onProgress?.({
      total: units.length,
      translated,
      reused: plan.reused.length,
      failed: failed.length,
      unitId: entry.unit.id
    })

    if (consecutiveFailures >= maxConsecutiveFailures) {
      stopped = 'repeated-failures'
      break
    }
  }

  if (stopped !== null) {
    // Every unit the run attempted (translated, failed) or had already proven done is in `kept`; the rest of the
    // plan is what the stop cut off.
    skipped = plan.toTranslate.filter((entry) => kept[entry.unit.id] === undefined).length
  }

  await persist()

  return {
    restored,
    total: units.length,
    translated,
    reused: plan.reused.length,
    failed,
    skipped,
    stopped,
    checkpointPath
  }
}
