import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { PdfEmbeddedAnnotation, PdfImportedPage } from '../../shared/pdf-annotation-import'
import {
  PDF_EMBEDDED_UNNAMED_SUBTYPE,
  PdfAnnotationImportError
} from '../../shared/pdf-annotation-import'
import type { PdfTextItem } from '../../shared/pdf-table-extraction'

// Reading the annotations a PDF carries (文档标注层 A2), with the PDF parser this app already ships.
//
// pdfjs is loaded from the legacy build, with the same options the uploads text-extraction path and the
// PDF-explore service use (cMap + standard-font data resolved off the installed package, no eval, no
// system fonts) — one parser configuration for the whole app rather than a second, subtly different one
// for annotations.
//
// What this module does NOT do: decide anything. It hands back the page boxes, the text layer and the
// annotations exactly as the file states them, in page user space (points, y up). Turning that into our
// own kinds, selectors and quotes is `mapEmbeddedPdfAnnotation`'s job, and it lives in shared/ where it
// is tested without a PDF at all.
//
// Two read-side choices worth knowing, both of them about not losing annotations quietly:
//
//   * the annotations are asked for with the ANY intent, and the display decision is made by
//     `mapEmbeddedPdfAnnotation` from the file's own flags. pdf.js's display intent is not "what a
//     viewer shows": it hides every text markup that carries only a /Rect and no /QuadPoints (its
//     `viewable` getter requires quad points), and it hides them SILENTLY — no warning, nothing the
//     caller can count. Reading with ANY surfaces them, and the mapper then skips what the file marks
//     hidden or no-view BY NAME, which is the difference between a report and a hole in one.
//   * a page's text layer is read only when that page actually carries an annotation. A 200-page scan
//     with markup on three pages costs three text reads, and the quote extraction still gets the items
//     for every page that needs them.

export type PdfParsedAnnotations = {
  pageCount: number
  pages: readonly PdfImportedPage[]
  /** Every annotation of every page, in page order, each tagged with its page number. */
  annotations: readonly PdfEmbeddedAnnotation[]
}

const resolvePdfjsAssetUrls = async (): Promise<{
  cMapUrl: string
  standardFontDataUrl: string
}> => {
  const require = createRequire(import.meta.url)
  const packageDir = dirname(require.resolve('pdfjs-dist/package.json'))

  return {
    cMapUrl: `${pathToFileURL(join(packageDir, 'cmaps')).href}/`,
    standardFontDataUrl: `${pathToFileURL(join(packageDir, 'standard_fonts')).href}/`
  }
}

// `page.view` is [x1, y1, x2, y2] of the page box in user space; the width/height the normalized
// selector needs is its extent. An empty or malformed box yields 0, which the mapper refuses (nothing
// can be normalized against a page with no size) instead of dividing by it.
const pageBox = (view: unknown): { width: number; height: number } => {
  if (!Array.isArray(view) || view.length < 4) return { width: 0, height: 0 }
  const [x1, y1, x2, y2] = view as number[]
  return { width: Math.abs(x2 - x1) || 0, height: Math.abs(y2 - y1) || 0 }
}

const readPageItems = (items: readonly unknown[]): PdfTextItem[] => {
  const positioned: PdfTextItem[] = []
  for (const item of items) {
    const entry = item as {
      str?: unknown
      transform?: unknown
      width?: unknown
      height?: unknown
    }
    if (typeof entry.str !== 'string' || entry.str.trim() === '') continue
    const transform = Array.isArray(entry.transform) ? entry.transform : []
    positioned.push({
      text: entry.str,
      x: typeof transform[4] === 'number' ? transform[4] : 0,
      y: typeof transform[5] === 'number' ? transform[5] : 0,
      width: typeof entry.width === 'number' ? entry.width : 0,
      height: typeof entry.height === 'number' ? entry.height : 0
    })
  }
  return positioned
}

const readAnnotation = (raw: unknown, pageNumber: number): PdfEmbeddedAnnotation => {
  const entry = raw as {
    subtype?: unknown
    rect?: unknown
    quadPoints?: unknown
    contents?: unknown
    contentsObj?: { str?: unknown }
    annotationFlags?: unknown
  }
  const contents =
    typeof entry.contentsObj?.str === 'string'
      ? entry.contentsObj.str
      : typeof entry.contents === 'string'
        ? entry.contents
        : ''
  const subtype = typeof entry.subtype === 'string' ? entry.subtype : ''

  return {
    page: pageNumber,
    // An annotation whose dictionary has no /Subtype (the parser hands those over too, with a warning)
    // is labelled rather than dropped: the report can then say "there is something here this build does
    // not import", which is a fact, instead of leaving a hole nothing accounts for.
    subtype: subtype.trim() === '' ? PDF_EMBEDDED_UNNAMED_SUBTYPE : subtype,
    rect: entry.rect,
    quadPoints: entry.quadPoints,
    contents,
    flags: typeof entry.annotationFlags === 'number' ? entry.annotationFlags : 0
  }
}

/**
 * Parses a PDF and returns its page boxes, text layers and embedded annotations.
 *
 * Throws `PdfAnnotationImportError('unreadable-pdf')` for a file the parser refuses (damaged,
 * truncated, or not a PDF at all) — with the parser's own message attached, because "unreadable PDF"
 * on its own is not something a reader can act on. Nothing is written before this returns.
 */
export const readPdfEmbeddedAnnotations = async (
  bytes: Uint8Array
): Promise<PdfParsedAnnotations> => {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
  const { cMapUrl, standardFontDataUrl } = await resolvePdfjsAssetUrls()

  let document: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>
  try {
    document = await pdfjs.getDocument({
      data: bytes,
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0
    }).promise
  } catch (error) {
    throw new PdfAnnotationImportError(
      'unreadable-pdf',
      `The PDF could not be parsed, so nothing was imported: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    const pages: PdfImportedPage[] = []
    const annotations: PdfEmbeddedAnnotation[] = []

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      try {
        const raw = (await page.getAnnotations({ intent: 'any' })) as readonly unknown[]
        const pageAnnotations: PdfEmbeddedAnnotation[] = raw.map((entry) =>
          readAnnotation(entry, pageNumber)
        )

        const { width, height } = pageBox(page.view)
        const rotate = typeof page.rotate === 'number' ? page.rotate : 0

        // The text layer is only needed to quote what a text markup covers, so a page without
        // annotations does not pay for it.
        let items: PdfTextItem[] = []
        if (pageAnnotations.length > 0) {
          const content = await page.getTextContent()
          items = readPageItems(content.items as readonly unknown[])
        }

        pages.push({ number: pageNumber, width, height, rotate, items })
        annotations.push(...pageAnnotations)
      } finally {
        page.cleanup()
      }
    }

    return { pageCount: document.numPages, pages, annotations }
  } catch (error) {
    // A page that fails halfway through is the same outcome as a document that fails to open: the
    // caller gets a named failure, and nothing has been written.
    throw new PdfAnnotationImportError(
      'unreadable-pdf',
      `The PDF could not be read to the end, so nothing was imported: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    await document.destroy()
  }
}
