// A PDF's stored page text, turned into the answer the agent's `pdf_translate` tool gives.
//
// The engine wiring lives in `run-translation.ts` — one runner, one refusal vocabulary, one place that
// creates the checkpoint store and the provider translator. This layer is the *document* half of that seam:
// it segments the page text into paragraph units, names the document identity those units belong to, calls
// the runner, and then reads the checkpoint back to answer with a per-paragraph list (the runner reports
// counts; the tool has to show the paragraphs themselves, each with its source and its translation).
//
// The paragraph list is built from the store, never from the run's bookkeeping: a translation that did not
// land on disk is not a translation, and a paragraph the run never reached carries that name.
//
// A run's unit of work is the whole document. That is not a simplification: the runner's checkpoint is keyed
// to the document's text and its plan drops records whose paragraph is gone from the source, so handing it a
// subset of the pages would both invalidate the checkpoint and delete the records of the pages left out.

import type {
  PdfTranslatedPage,
  PdfTranslatedParagraph,
  PdfTranslateResult,
  PdfTranslationRestored
} from '../../shared/pdf'
import {
  segmentPageIntoTranslationUnits,
  TRANSLATION_UNIT_MAX_CHARS,
  type TranslationUnit
} from '../../shared/translation-units'
import {
  TranslationCheckpointStore,
  translationSourceContentHash,
  type TranslationSourceIdentity
} from './checkpoint-store'
import type { TranslationRestoredState } from './engine'
import {
  createTranslationRunner,
  type TranslationRunnerRefusal,
  type TranslationTargetLookup
} from './run-translation'

export type PdfTranslationOutcome =
  | { ok: true; result: PdfTranslateResult }
  | { ok: false; reason: TranslationRunnerRefusal; detail: string }

export type DocumentTranslationInput = {
  docId: string
  /** Every page of the document, in page order. See the note above on why a subset is not accepted. */
  documentPages: readonly { page: number; text: string }[]
  /** Where checkpoints live: resolved once by the caller, so the read side uses the same root. */
  storageRoot: string
  /** Which endpoint and model this run uses. Asked on every call, so a settings change takes effect. */
  target: () => Promise<TranslationTargetLookup> | TranslationTargetLookup
  targetLanguage?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Consulted before each unit, so a caller can end a long run without losing what it already stored. */
  shouldStop?: () => boolean
  maxChars?: number
  onProgress?: (progress: {
    total: number
    translated: number
    reused: number
    failed: number
  }) => void
}

const mapRestored = (restored: TranslationRestoredState): PdfTranslationRestored =>
  restored.state === 'partial'
    ? { state: 'partial', records: restored.records }
    : {
        state: 'none',
        reason: restored.reason,
        // "Read failed" keeps its own name: a caller that only sees `no-checkpoint` would read a corrupt
        // checkpoint as "nothing was translated yet" and silently start over.
        ...('detail' in restored ? { detail: restored.detail } : {})
      }

const paragraphOf = (
  unit: TranslationUnit,
  record: { status: 'translated' | 'failed'; text?: string; reason?: string } | undefined
): PdfTranslatedParagraph => {
  if (record?.status === 'translated' && typeof record.text === 'string' && record.text !== '') {
    return {
      id: unit.id,
      page: unit.page,
      paragraph: unit.paragraph,
      status: 'translated',
      source: unit.text,
      translation: record.text
    }
  }
  return {
    id: unit.id,
    page: unit.page,
    paragraph: unit.paragraph,
    status: 'failed',
    source: unit.text,
    // No record means the run stopped before reaching this paragraph. It is named, so an absent
    // translation can never be read as an empty or a successful one.
    reason: record?.reason ?? 'not-attempted'
  }
}

export const runDocumentTranslation = async ({
  docId,
  documentPages,
  storageRoot,
  target,
  targetLanguage,
  fetchImpl,
  now,
  shouldStop,
  maxChars = TRANSLATION_UNIT_MAX_CHARS,
  onProgress
}: DocumentTranslationInput): Promise<PdfTranslationOutcome> => {
  const ordered = [...documentPages].sort((left, right) => left.page - right.page)
  const units = ordered.flatMap((page) =>
    segmentPageIntoTranslationUnits(page.page, page.text, { maxChars })
  )
  const source: TranslationSourceIdentity = {
    kind: 'pdf',
    id: docId,
    contentHash: translationSourceContentHash(ordered.map((page) => page.text))
  }

  const runner = createTranslationRunner({
    storageRoot: () => storageRoot,
    target,
    ...(targetLanguage ? { targetLanguage } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(now ? { now } : {}),
    ...(shouldStop ? { shouldStop } : {}),
    ...(onProgress ? { onProgress } : {})
  })
  const reply = await runner.run({ source, units })
  // A refusal is a refusal: no empty checkpoint is written for a document with nothing to translate, and
  // no endpoint means the run does not start at all.
  if (!reply.ok) return { ok: false, reason: reply.reason, detail: reply.detail }

  const store = new TranslationCheckpointStore({ root: storageRoot, ...(now ? { now } : {}) })
  const persisted = await store.read(source)
  const records = persisted.state === 'ok' ? persisted.checkpoint.records : {}

  const pagesWithParagraphs = new Map<number, PdfTranslatedPage>()
  for (const unit of units) {
    const entry = pagesWithParagraphs.get(unit.page) ?? { page: unit.page, paragraphs: [] }
    entry.paragraphs.push(paragraphOf(unit, records[unit.id]))
    pagesWithParagraphs.set(unit.page, entry)
  }

  return {
    ok: true,
    result: {
      docId,
      targetLanguage: targetLanguage ?? 'Simplified Chinese',
      pages: [...pagesWithParagraphs.values()],
      paragraphCount: units.length,
      translated: reply.report.translated,
      reused: reply.report.reused,
      failed: reply.report.failed,
      skipped: reply.report.skipped,
      stopped: reply.report.stopped,
      restored: mapRestored(reply.report.restored),
      emptyPages: ordered
        .filter((page) => !pagesWithParagraphs.has(page.page))
        .map((page) => page.page),
      checkpointPath: reply.report.checkpointPath
    }
  }
}
