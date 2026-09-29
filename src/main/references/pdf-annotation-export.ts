import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  buildAnnotatedPdfCopy,
  buildPdfAnnotationNotes,
  isPdfAnnotationExportChannel,
  isPdfFileName,
  type PdfAnnotationBurnCandidate,
  type PdfAnnotationExportChannel,
  type PdfAnnotationExportKindCount,
  type PdfAnnotationExportProvenance
} from '../../shared/pdf-annotation-export'
import type {
  PdfAnnotationAnchorRequest,
  PdfAnnotationExportOutcome,
  PdfAnnotationExportRequest,
  PdfAnnotationView
} from '../../shared/pdf-annotation-surface'
import type {
  PdfAnnotationVersionFileResolver,
  PdfAnnotationService
} from './pdf-annotation-service'

// The two export channels (文档标注层 A4), on the main-process side — where the version's bytes live.
//
// Three things are decided here, and each one is a way an export could quietly be untrue:
//
//   1. WHICH BYTES ARE THE SOURCE. The version authority turns (project, session, artifact, version) into
//      a file path, and the bytes at that path are hashed. Bytes that do not hash to the version's own
//      checksum stop the export by name: a copy made from them would be a copy of something the reader
//      never annotated, carrying markup anchored to bytes it does not have.
//   2. THE SOURCE IS READ, NEVER WRITTEN. Neither channel opens the version's file for writing — the copy
//      is a second file, and the notes channel signs no PDF at all. That is asserted rather than intended:
//      the annotated channel hashes the source AGAIN after the copy has been written and refuses to
//      report success if the two digests differ.
//   3. EACH CHANNEL LANDS ITS OWN FILE, OR SAYS WHY NOT. The two channels share no output: the annotated
//      channel's receipt carries a copy and no notes, the notes channel's carries notes and no copy, and a
//      cancelled save is reported as cancelled — never as an export with a file nobody wrote.

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Where one channel's bytes land. The one seam a save-to-file flow needs; `null` means the reader cancelled. */
export type PdfAnnotationExportWriter = (request: {
  channel: PdfAnnotationExportChannel
  suggestedName: string
  bytes: Uint8Array
}) => Promise<string | null>

export type PdfAnnotationExportServiceDependencies = {
  /** The same read the panel makes, so both channels see every annotation of the file with its anchor state. */
  annotations: Pick<PdfAnnotationService, 'list'>
  resolveVersionFile: PdfAnnotationVersionFileResolver
  write: PdfAnnotationExportWriter
  /** Injectable so a test drives the channels without a real install's disk layout. */
  readBytes?: (path: string) => Promise<Uint8Array>
  now?: () => number
}

// One request, checked before a byte is read. Every channel is addressed by the four identity facts, and
// a request missing one is refused here rather than resolved against a default.
const requireRequest = (request: PdfAnnotationExportRequest): void => {
  const missing = (
    [
      ['projectId', request.projectId],
      ['sessionId', request.sessionId],
      ['artifactId', request.artifactId],
      ['versionId', request.versionId]
    ] as const
  )
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(
      `A PDF annotation export must name the file version it exports from; ${missing.join(', ')} is missing.`
    )
  }
}

/**
 * The file name a channel derives for itself.
 *
 * The window may suggest the name it displays, and nothing more is taken from it: the extension and the
 * suffix are decided HERE, so the window cannot hand this layer a name that lands a notes export behind a
 * `.pdf` extension or that reaches outside the directory the reader picked.
 */
const suggestedBaseName = (
  request: PdfAnnotationExportRequest,
  channel: PdfAnnotationExportChannel
): string => {
  const raw = basename((request.fileName ?? '').trim()).replace(/\.pdf$/i, '')
  // Control characters are dropped by code point rather than by a character class: a class spanning
  // 0x00–0x1f in a regular expression is the one thing lint here is right to object to, and a file name
  // with a newline in it would reach the save dialog as a second line.
  const cleaned = [...raw]
    .filter((character) => character.charCodeAt(0) > 0x1f && !'/\\:*?"<>|'.includes(character))
    .join('')
    .trim()
  const stem = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'document' : cleaned
  return channel === 'notes' ? `${stem} (annotations).txt` : `${stem} (annotated).pdf`
}

const pageOf = (view: PdfAnnotationView): number | undefined => {
  const selector = view.annotation.selector as unknown as Record<string, unknown>
  return typeof selector.page === 'number' ? selector.page : undefined
}

/** The passage a markup quotes, or the text a note carries — the same choice the panel makes when it lists one. */
const textOf = (view: PdfAnnotationView): string => {
  const selector = view.annotation.selector as unknown as Record<string, unknown>
  if (selector.shape === 'text-range' && typeof selector.quote === 'string') return selector.quote
  return view.annotation.body
}

const kindsOf = (listed: PdfAnnotationListRead): readonly PdfAnnotationExportKindCount[] => {
  const counts = new Map<string, number>()
  for (const view of listed.annotations) {
    counts.set(view.annotation.kind, (counts.get(view.annotation.kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind: kind as PdfAnnotationExportKindCount['kind'], count }))
    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind))
}

type PdfAnnotationListRead = Awaited<ReturnType<PdfAnnotationService['list']>>

export class PdfAnnotationExportService {
  private readonly readBytes: (path: string) => Promise<Uint8Array>
  private readonly now: () => number

  constructor(private readonly dependencies: PdfAnnotationExportServiceDependencies) {
    this.readBytes =
      dependencies.readBytes ??
      (async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path)))
    this.now = dependencies.now ?? ((): number => Date.now())
  }

  /**
   * The `annotated-pdf` channel: the markup of the version on screen, written into a COPY of its bytes.
   *
   * Only the version's own markup is written. An annotation anchored to another version is named in the
   * receipt as `another-version` rather than placed on bytes it was never drawn on — the same state the
   * panel reports in the window, carried through to the file.
   */
  async exportAnnotatedPdf(
    request: PdfAnnotationExportRequest
  ): Promise<PdfAnnotationExportOutcome> {
    return this.export('annotated-pdf', request)
  }

  /** The `notes` channel: the same read, as a plain-text list. Writes no PDF of any kind. */
  async exportNotes(request: PdfAnnotationExportRequest): Promise<PdfAnnotationExportOutcome> {
    return this.export('notes', request)
  }

  private async export(
    channel: PdfAnnotationExportChannel,
    request: PdfAnnotationExportRequest
  ): Promise<PdfAnnotationExportOutcome> {
    if (!isPdfAnnotationExportChannel(channel)) {
      throw new Error(`Unknown PDF annotation export channel "${channel}".`)
    }
    requireRequest(request)

    const anchorRequest: PdfAnnotationAnchorRequest = {
      projectId: request.projectId,
      sessionId: request.sessionId,
      artifactId: request.artifactId,
      versionId: request.versionId
    }

    // The read the panel makes: every annotation of the file, each labelled against the version on
    // screen. `anchor.checksum` is the version authority's own number, so both channels are addressed by
    // the same anchor the store writes under — not by a checksum the window supplied.
    const listed = await this.dependencies.annotations.list(anchorRequest)
    const exportedAt = this.now()
    const provenance: PdfAnnotationExportProvenance = {
      projectId: anchorRequest.projectId,
      sessionId: anchorRequest.sessionId,
      sourceFileId: listed.anchor.sourceFileId,
      versionId: listed.anchor.versionId,
      checksum: listed.anchor.checksum,
      exportedAt
    }

    try {
      return channel === 'notes'
        ? await this.exportNotesFile({ request, listed, provenance })
        : await this.exportAnnotatedCopy({ request, listed, provenance, exportedAt })
    } catch (error) {
      // A throw here is a channel that could not finish — a destination that refused the write, a file
      // that vanished between the read and the copy. Reported as a named failure with the error's own
      // words attached: the window shows both, and neither is dressed up as an export.
      return {
        status: 'failure',
        channel,
        code: 'write-failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  // --- the annotated copy -------------------------------------------------------------------------------

  private async exportAnnotatedCopy(input: {
    request: PdfAnnotationExportRequest
    listed: PdfAnnotationListRead
    provenance: PdfAnnotationExportProvenance
    exportedAt: number
  }): Promise<PdfAnnotationExportOutcome> {
    const { listed, provenance } = input
    let sourcePath: string
    let source: Uint8Array
    try {
      sourcePath = await this.dependencies.resolveVersionFile(input.request)
      source = await this.readBytes(sourcePath)
    } catch (error) {
      return {
        status: 'failure',
        channel: 'annotated-pdf',
        code: 'unreadable-source',
        message: `The version's file could not be read, so no copy was made: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    const checksumBefore = sha256Hex(source)
    if (checksumBefore !== provenance.checksum) {
      return {
        status: 'failure',
        channel: 'annotated-pdf',
        code: 'checksum-mismatch',
        message: `The file on disk hashes to ${checksumBefore}, while version ${provenance.versionId} is anchored at ${provenance.checksum}. No copy was made: markup written from other bytes would be anchored to a version it does not have.`
      }
    }

    const candidates: PdfAnnotationBurnCandidate[] = listed.annotations.map((view) => ({
      kind: view.annotation.kind,
      selector: view.annotation.selector,
      body: view.annotation.body,
      anchorState: view.anchorState
    }))
    const built = buildAnnotatedPdfCopy({
      source,
      annotations: candidates,
      exportedAt: input.exportedAt
    })
    if (built.status === 'refused') {
      return {
        status: 'failure',
        channel: 'annotated-pdf',
        code: built.code,
        message: built.message
      }
    }

    const written = await this.dependencies.write({
      channel: 'annotated-pdf',
      suggestedName: suggestedBaseName(input.request, 'annotated-pdf'),
      bytes: built.bytes
    })
    if (written === null) return { status: 'cancelled', channel: 'annotated-pdf' }

    // The red line, checked rather than asserted: the version's bytes are hashed AGAIN, from disk, after
    // the copy exists. A channel that wrote to the wrong path — or a file that changed underneath the
    // export — is reported, never dressed up as a success.
    const checksumAfter = sha256Hex(await this.readBytes(sourcePath))
    if (checksumAfter !== checksumBefore) {
      return {
        status: 'failure',
        channel: 'annotated-pdf',
        code: 'source-changed',
        message: `The source file hashed to ${checksumBefore} before the copy was written and to ${checksumAfter} after it. This channel does not write it, so something else did; the copy was not reported as an export of these bytes.`
      }
    }

    return {
      status: 'exported',
      receipt: {
        channel: 'annotated-pdf',
        provenance,
        anchorChecksum: provenance.checksum,
        sourceBytes: { path: sourcePath, checksumBefore, checksumAfter, bytes: source.length },
        annotationsInStore: listed.annotations.length,
        annotationsExported: built.burned.burnedCount,
        kinds: built.burned.kinds,
        copy: {
          path: written,
          bytes: built.bytes.length,
          sourceBytes: built.sourceBytes,
          appendedBytes: built.appendedBytes,
          pageCount: built.pageCount
        },
        // The other channel is what lists what a copy cannot carry; here they are reported as skipped,
        // with their reason, so the two counts can never disagree silently.
        notes: null,
        skipped: built.burned.skipped,
        exportedAt: input.exportedAt
      }
    }
  }

  // --- the notes list ------------------------------------------------------------------------------------

  private async exportNotesFile(input: {
    request: PdfAnnotationExportRequest
    listed: PdfAnnotationListRead
    provenance: PdfAnnotationExportProvenance
  }): Promise<PdfAnnotationExportOutcome> {
    const { listed, provenance } = input
    // Every annotation of the file, oldest first — the same set the panel lists, which is what makes "the
    // file lists as many annotations as the store holds" a checkable statement rather than a hope.
    const notes = buildPdfAnnotationNotes({
      provenance,
      entries: listed.annotations.map((view) => {
        const page = pageOf(view)
        return {
          kind: view.annotation.kind,
          ...(page === undefined ? {} : { page }),
          versionId: view.annotation.versionId,
          text: textOf(view),
          body: view.annotation.body,
          anchorState: view.anchorState
        }
      })
    })

    const bytes = new TextEncoder().encode(notes.text)
    const written = await this.dependencies.write({
      channel: 'notes',
      suggestedName: suggestedBaseName(input.request, 'notes'),
      bytes
    })
    if (written === null) return { status: 'cancelled', channel: 'notes' }

    // Stated rather than implied: this channel signs no PDF, so a destination that names one is refused
    // rather than reported as an export. A `notes` run that quietly produced a PDF would be a second
    // annotated channel nobody asked for.
    if (isPdfFileName(basename(written))) {
      return {
        status: 'failure',
        channel: 'notes',
        code: 'write-failed',
        message: `The notes channel was handed "${basename(written)}", which names a PDF. It writes no PDF, so nothing is reported as exported.`
      }
    }

    return {
      status: 'exported',
      receipt: {
        channel: 'notes',
        provenance,
        anchorChecksum: provenance.checksum,
        // This channel reads the store, not the PDF: it never opens the version's file, so there are no
        // bytes of it to report. Its receipt says so rather than restating the anchor as if it had.
        sourceBytes: null,
        annotationsInStore: listed.annotations.length,
        annotationsExported: notes.entryLines,
        kinds: kindsOf(listed),
        copy: null,
        notes: { path: written, bytes: bytes.length, entryLines: notes.entryLines },
        skipped: [],
        exportedAt: provenance.exportedAt
      }
    }
  }
}
