// Structured release-notes parser for the update dialog (issue #17 / U1).
//
// Where the text comes from: `version.json` carries the repository's own CHANGELOG entry for the
// version, so the dialog and the release page cannot disagree. Until now the dialog handed that text
// to a Markdown renderer and the notes read as one block of prose. This module turns the SAME text
// into a small structured document — group titles, numbered entries, and a bold lead inside an entry
// (`**Subtitle** — the one sentence that explains it`).
//
// Controlled subset (deliberately tiny, and the only thing the renderer interprets):
//   `#`/`##`/…  heading        -> a group title
//   `-`/`*`/`+` bullet          -> a numbered entry
//   `**bold**`                  -> the entry's subtitle when it leads, otherwise inline emphasis
//   `` `code` ``                -> inline code
//   a bare 7-40 char hex token  -> the change reference (this repo cites commits, not issue numbers)
//
// Lenient IN, verbatim OUT: anything else — tables, quotes, links, rules, HTML, an unterminated `**`,
// a hand-numbered `1.` list — is NOT interpreted. It stays paragraph text exactly as it was written.
// Nothing is dropped, reordered or truncated: every source line lands in exactly one node and the
// `lines` array here is the round-trip check the tests assert against.
//
// Pure and dependency-free on purpose: no Markdown library is pulled in for this surface.

export type ReleaseNoteSpanKind = 'text' | 'strong' | 'code' | 'ref'

export type ReleaseNoteSpan = {
  kind: ReleaseNoteSpanKind
  text: string
}

// One `-` bullet: `raw` is the source line, `title` is the leading bold subtitle when the author
// wrote one, `body` is everything else (the description).
export type ReleaseNoteEntry = {
  raw: string
  title?: string
  body: ReleaseNoteSpan[]
}

// A run of consecutive non-bullet, non-heading lines, kept with their original line breaks.
export type ReleaseNoteParagraph = {
  lines: string[]
  spans: ReleaseNoteSpan[]
}

export type ReleaseNoteBlock =
  ({ kind: 'paragraph' } & ReleaseNoteParagraph) | ({ kind: 'entry' } & ReleaseNoteEntry)

export type ReleaseNoteGroup = {
  // The source heading line, verbatim (absent for the leading group when the notes start with content
  // before any heading).
  raw?: string
  // The heading text. Absent means "no heading was written" — the renderer labels that group itself.
  title?: string
  blocks: ReleaseNoteBlock[]
}

export type ReleaseNotesDoc = {
  groups: ReleaseNoteGroup[]
  // Every non-blank source line, in document order: the no-content-loss invariant, asserted by tests.
  lines: string[]
}

const HEADING = /^#{1,6}\s+(.+?)\s*$/
const BULLET = /^[-*+•]\s+(.+?)\s*$/
// Bold or inline code. Both openers must close: an unterminated `**` stays literal text.
const INLINE = /\*\*([\s\S]+?)\*\*|`([^`\n]+)`/g
// A change reference: a standalone hex token of sensible commit length. A pure-letter hex word
// ("deadbeef", "facade") is not a commit id, so at least one digit is required.
const HEX_REFERENCE = /(?<![0-9a-zA-Z_])[0-9a-fA-F]{7,40}(?![0-9a-zA-Z_])/g

// Splits literal text around change references. The text itself is never altered — only re-split.
const splitReferences = (text: string): ReleaseNoteSpan[] => {
  const spans: ReleaseNoteSpan[] = []
  let cursor = 0
  for (const match of text.matchAll(HEX_REFERENCE)) {
    const token = match[0]
    if (!/[0-9]/.test(token)) continue
    const index = match.index ?? 0
    if (index > cursor) spans.push({ kind: 'text', text: text.slice(cursor, index) })
    spans.push({ kind: 'ref', text: token })
    cursor = index + token.length
  }
  if (cursor < text.length) spans.push({ kind: 'text', text: text.slice(cursor) })
  return spans
}

// Inline spans for one line of notes. `spans.map(s => s.text).join('')` always equals the input — the
// tests rely on that to prove no character is dropped.
export const parseReleaseNoteSpans = (text: string): ReleaseNoteSpan[] => {
  const spans: ReleaseNoteSpan[] = []
  let cursor = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > cursor) spans.push(...splitReferences(text.slice(cursor, index)))
    if (match[1] !== undefined) spans.push({ kind: 'strong', text: match[1] })
    else spans.push({ kind: 'code', text: match[2] })
    cursor = index + match[0].length
  }
  if (cursor < text.length) spans.push(...splitReferences(text.slice(cursor)))
  return spans
}

const buildEntry = (raw: string, text: string): ReleaseNoteEntry => {
  const spans = parseReleaseNoteSpans(text)
  const lead = spans[0]
  if (lead?.kind !== 'strong' || lead.text.trim() === '') return { raw, body: spans }

  const body = spans.slice(1)
  let title = lead.text.trim()
  // A colon that joined the bold lead to its explanation stays on the title line — the description
  // then reads as a sentence, and the punctuation is still on screen rather than dropped.
  const next = body[0]
  const colon = next?.kind === 'text' ? next.text.match(/^([:：])/) : null
  if (colon && next) {
    title = `${title}${colon[1]}`
    const rest = next.text.slice(colon[1].length)
    if (rest === '') body.shift()
    else body[0] = { ...next, text: rest }
  }
  return { raw, title, body }
}

export const parseReleaseNotes = (raw: string): ReleaseNotesDoc => {
  const text = typeof raw === 'string' ? raw : ''
  const groups: ReleaseNoteGroup[] = []
  const lines: string[] = []
  let group: ReleaseNoteGroup = { blocks: [] }
  let pending: ReleaseNoteParagraph | undefined

  const flushParagraph = (): void => {
    if (pending && pending.lines.length > 0) {
      group.blocks.push({
        kind: 'paragraph',
        lines: pending.lines,
        // Hard-wrapped source lines stay one block, so inline markup spanning a line break still
        // resolves and the original line breaks survive (`whitespace-pre-wrap` on the renderer).
        spans: parseReleaseNoteSpans(pending.lines.join('\n'))
      })
    }
    pending = undefined
  }
  const flushGroup = (): void => {
    flushParagraph()
    if (group.raw !== undefined || group.blocks.length > 0) groups.push(group)
  }

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      // A blank line separates blocks; it is not content, so it never renders as an empty box.
      flushParagraph()
      continue
    }
    lines.push(line)

    const heading = line.trim().match(HEADING)
    if (heading) {
      flushGroup()
      group = { raw: line, title: heading[1], blocks: [] }
      continue
    }

    const bullet = line.trim().match(BULLET)
    if (bullet) {
      flushParagraph()
      group.blocks.push({ kind: 'entry', ...buildEntry(line, bullet[1]) })
      continue
    }

    // Everything else is verbatim paragraph text; consecutive lines stay one block.
    if (!pending) pending = { lines: [], spans: [] }
    pending.lines.push(line)
  }
  flushGroup()

  return { groups, lines }
}
