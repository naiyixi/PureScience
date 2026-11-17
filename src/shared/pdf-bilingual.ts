// Page-anchored bilingual reading for a paper.
//
// The product can already pull a PDF's page text and its table candidates. What it could not do is hand a
// reader the same page twice — original beside translation — without losing the anchor that makes the
// translation checkable. This module is that half: it decides which pages travel together to the model,
// then assembles the result so every translated paragraph still says which page it came from, and a page
// the reader could not see is reported as unread rather than silently dropped.
//
// Deliberately model-agnostic and pure: no IO, no provider, no prompt text. The caller supplies the
// translations; the shape of what comes back is pinned here.

export type PdfTranslationPage = Readonly<{
  pageNumber: number
  /** Page text as read from the document's own text layer; '' when the page carries none. */
  text: string
}>

export type PdfTranslationBatch = Readonly<{
  pages: readonly PdfTranslationPage[]
  /** Total characters in this batch, so a caller can budget a provider's context without re-measuring. */
  charCount: number
}>

/** Pages with no text layer are never sent to a model: there is nothing to translate, and paying for it
 * would produce an invented page. They are returned separately so the caller can say so out loud. */
export const splitTranslatablePages = (
  pages: readonly PdfTranslationPage[]
): Readonly<{ translatable: readonly PdfTranslationPage[]; unreadable: readonly number[] }> => {
  const translatable: PdfTranslationPage[] = []
  const unreadable: number[] = []
  for (const page of pages) {
    if (page.text.trim().length === 0) unreadable.push(page.pageNumber)
    else translatable.push(page)
  }
  return { translatable, unreadable }
}

/** Groups consecutive pages so no batch exceeds `maxChars`, keeping page order. A single page longer than
 * the budget still travels alone rather than being truncated: cutting a page in half would attribute
 * sentences to the wrong anchor. */
export const planTranslationBatches = (
  pages: readonly PdfTranslationPage[],
  maxChars: number
): readonly PdfTranslationBatch[] => {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error('maxChars must be a positive number')
  }
  const batches: PdfTranslationBatch[] = []
  let current: PdfTranslationPage[] = []
  let currentChars = 0

  const flush = (): void => {
    if (current.length === 0) return
    batches.push({ pages: current, charCount: currentChars })
    current = []
    currentChars = 0
  }

  for (const page of pages) {
    const size = page.text.length
    if (current.length > 0 && currentChars + size > maxChars) flush()
    current.push(page)
    currentChars += size
  }
  flush()
  return batches
}

export type BilingualPage = Readonly<{
  pageNumber: number
  original: string
  /** The translation, or null when the page was translated by nobody — rendered as an explicit gap. */
  translated: string | null
}>

const escapeMarkdownHeading = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Renders the reading pair as one markdown document: a heading per page, original first, translation
 * under it, and a stated reason where there is none. Nothing is invented for a page that had no text. */
export const assembleBilingualMarkdown = (
  input: Readonly<{
    title: string
    pages: readonly BilingualPage[]
    unreadablePages?: readonly number[]
  }>
): string => {
  const lines: string[] = [`# ${escapeMarkdownHeading(input.title) || 'Translated document'}`, '']
  const unreadable = new Set(input.unreadablePages ?? [])

  for (const page of [...input.pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    lines.push(`## Page ${page.pageNumber}`, '')
    lines.push('**Original**', '', page.original.trim(), '')
    lines.push('**Translation**', '')
    if (page.translated === null) {
      lines.push(
        unreadable.has(page.pageNumber)
          ? '_Not translated: this page has no text layer, so there is nothing to translate._'
          : '_Not translated: no translation was returned for this page._'
      )
    } else {
      lines.push(page.translated.trim())
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}
