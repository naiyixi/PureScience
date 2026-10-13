// The window's translation entry: reading (rebuilding the panel's view from the records on disk) and
// running (actually translating) are the two halves of one seam.
//
// Where it sits: the reader looks at a *file*, while the engine, the endpoint and the checkpoint root
// belong to the main process — so this layer is handed those three by the composition site, which is the
// one place that already holds all of them (the same rule that keeps one data root resolved once).
//
// Three rules it is responsible for:
//
//  1. **A file resolves to a stable document identity** (`ensureDoc`), never a fresh registration. A doc id
//     is minted from `path + time`, and the checkpoint file is named after the id ⇒ re-registering on every
//     press would make the "already translated paragraphs are reused" promise false, silently, the second
//     time the reader pressed the button.
//  2. **Both halves report what is on disk, in four named states** — never stored, the document changed, the
//     file could not be read, or usable records — because "read failed" must not read as "not translated yet"
//     (that distinction is `resolveCheckpointLoad`'s, and the run and the read share it).
//  3. **A refusal stays a refusal**: no endpoint (`not-configured`) and a document with no paragraphs at all
//     (`empty-source`) are named and reported as such, never as a "0 paragraph" translation.
//
// The answer's paragraphs come from the store, never from the run's own bookkeeping — the same discipline
// `document-translation.ts` follows for the agent's tool face: a translation that is not on disk is not a
// translation.

import type { PdfTranslationWindowRequest, PdfTranslationWindowResult } from '../../shared/pdf'
import {
  buildTranslationViewModel,
  type TranslationViewModel
} from '../../shared/translation-view-model'
import {
  readDocumentTranslation,
  runDocumentTranslation,
  type DocumentTranslationRead
} from './document-translation'
import type { TranslationTargetLookup } from './run-translation'

/** What `ensureDoc` answers: the document's stable identity and how many pages it has. */
export type WindowTranslationRegistration = {
  docId: string
  pageCount: number
  /** true ⇒ this file was already registered; the identity (and therefore the checkpoint) is unchanged. */
  reused: boolean
}

export type WindowTranslationDeps = {
  /** Resolves a file to the document identity that is already registered for it, or registers it once. */
  ensureDoc: (
    path: string,
    projectId: string,
    sessionId?: string
  ) => Promise<WindowTranslationRegistration>
  /** Every page of that document, in page order. Zero pages is a legitimate answer (nothing to read). */
  readPages: (
    docId: string,
    pageCount: number
  ) => Promise<readonly { page: number; text: string }[]>
  /** The checkpoint root, resolved by the storage layer — the same root the reader's own writes use. */
  storageRoot: () => string
  /** Asked on every call, so a provider changed in Settings takes effect on the next translation. */
  resolveTarget: () => Promise<TranslationTargetLookup>
  fetchImpl?: typeof fetch
}

export type WindowTranslation = (
  projectId: string,
  request: PdfTranslationWindowRequest
) => Promise<PdfTranslationWindowResult>

export const createWindowTranslation =
  (deps: WindowTranslationDeps): WindowTranslation =>
  async (projectId, request): Promise<PdfTranslationWindowResult> => {
    const registration = await deps.ensureDoc(request.path, projectId, request.sessionId)
    const pages = await deps.readPages(registration.docId, registration.pageCount)
    const storageRoot = deps.storageRoot()

    const read = (): Promise<DocumentTranslationRead> =>
      readDocumentTranslation({
        docId: registration.docId,
        documentPages: pages,
        storageRoot
      })

    const viewOf = (from: DocumentTranslationRead): TranslationViewModel =>
      buildTranslationViewModel({
        sourceId: registration.docId,
        sourceContentHash: from.contentHash,
        pages,
        records: from.records
      })

    // The read half: what is stored right now, with no model call and no write.
    const stored = await read()
    if (request.run !== true) {
      return { ran: false, restored: stored.restored, view: viewOf(stored) }
    }

    const targetLanguage = request.targetLanguage?.trim()
    const outcome = await runDocumentTranslation({
      docId: registration.docId,
      documentPages: pages,
      storageRoot,
      target: deps.resolveTarget,
      // A blank language is "not specified" here: this surface has no free-text field that could produce one,
      // so there is nothing to refuse by name (the agent's tool face, whose input is a model, does refuse it).
      ...(targetLanguage ? { targetLanguage } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
    })

    if (!outcome.ok) {
      // The run did not start, so nothing was written: what is on disk is still what the read above saw.
      return {
        ran: false,
        restored: stored.restored,
        refusal: { reason: outcome.reason, detail: outcome.detail },
        view: viewOf(stored)
      }
    }

    // Read the records back after the run: this is what the panel shows, so it has to be the store's answer.
    const after = await read()
    return {
      ran: true,
      run: {
        model: outcome.report.model,
        translated: outcome.report.translated,
        reused: outcome.report.reused,
        failed: outcome.report.failed.length,
        skipped: outcome.report.skipped,
        stopped: outcome.report.stopped,
        checkpointPath: outcome.report.checkpointPath
      },
      restored: after.restored,
      view: viewOf(after)
    }
  }
