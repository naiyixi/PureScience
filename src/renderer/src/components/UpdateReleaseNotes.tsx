import { useMemo } from 'react'

import { useLanguage } from '@/i18n'
import {
  parseReleaseNotes,
  type ReleaseNoteBlock,
  type ReleaseNoteEntry,
  type ReleaseNoteSpan
} from '@/lib/release-notes'

// Structured render of the release notes (issue #17 / U1): group titles, numbered entries, and a bold
// subtitle inside an entry when the note author wrote one. The parser next door interprets a tiny
// subset only; anything it does not understand is rendered verbatim as paragraph text, and a note the
// parser cannot structure at all falls back to the source text rather than an empty box.
//
// Layout is deliberately spill-proof: every text node breaks long unbroken runs (`break-words` plus
// `overflow-wrap: anywhere`) and every flex/box child carries `min-w-0`, so the longest translation in
// the longest note cannot push the panel wider than the dialog.

type SpanListProps = { spans: ReleaseNoteSpan[] }

const SpanList = ({ spans }: SpanListProps): React.JSX.Element => (
  <>
    {spans.map((span, index) => {
      if (span.kind === 'strong')
        return (
          <strong key={index} className="font-semibold text-foreground">
            {span.text}
          </strong>
        )
      if (span.kind === 'code')
        return (
          <code
            key={index}
            className="rounded bg-background/70 px-1 py-px font-mono text-[11px] [overflow-wrap:anywhere]"
          >
            {span.text}
          </code>
        )
      // A commit short SHA: kept readable as the change reference, never dropped or relinked.
      if (span.kind === 'ref')
        return (
          <span key={index} className="font-mono text-[11px] [overflow-wrap:anywhere]">
            {span.text}
          </span>
        )
      return <span key={index}>{span.text}</span>
    })}
  </>
)

const EntryItem = ({ entry }: { entry: ReleaseNoteEntry }): React.JSX.Element => (
  <li
    data-testid="release-note-entry"
    className="min-w-0 break-words pl-0.5 leading-relaxed [overflow-wrap:anywhere]"
  >
    {entry.title ? (
      <span
        data-testid="release-note-entry-title"
        className="font-semibold text-foreground [overflow-wrap:anywhere]"
      >
        {entry.title}
      </span>
    ) : null}
    {entry.title && entry.body.length > 0 ? (
      <>
        <br />
        <span className="text-muted-foreground">
          <SpanList spans={entry.body} />
        </span>
      </>
    ) : (
      <SpanList spans={entry.body} />
    )}
  </li>
)

// Runs of consecutive entries render as one numbered list; a paragraph between them starts a new list,
// so the entry order on screen is exactly the order in the notes.
type BlockRun =
  | { kind: 'list'; entries: ReleaseNoteEntry[] }
  | { kind: 'paragraph'; lines: string[]; spans: ReleaseNoteSpan[] }

const toRuns = (blocks: ReleaseNoteBlock[]): BlockRun[] => {
  const runs: BlockRun[] = []
  for (const block of blocks) {
    if (block.kind === 'entry') {
      const last = runs[runs.length - 1]
      if (last?.kind === 'list') last.entries.push(block)
      else runs.push({ kind: 'list', entries: [block] })
    } else {
      runs.push({ kind: 'paragraph', lines: block.lines, spans: block.spans })
    }
  }
  return runs
}

const UpdateReleaseNotes = ({ notes }: { notes: string }): React.JSX.Element => {
  const { t } = useLanguage()
  const doc = useMemo(() => parseReleaseNotes(notes), [notes])

  // R1: if nothing at all could be structured, show the source text — never an empty surface.
  if (doc.groups.length === 0) {
    return (
      <p
        data-testid="release-note-plain"
        className="min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
      >
        {notes.trim()}
      </p>
    )
  }

  return (
    <div data-testid="update-release-notes" className="min-w-0 space-y-3">
      {doc.groups.map((group, groupIndex) => (
        <section key={groupIndex} data-testid="release-note-group" className="min-w-0">
          <h3
            data-testid="release-note-group-title"
            className="min-w-0 break-words text-xs font-semibold text-foreground [overflow-wrap:anywhere]"
          >
            {/* The notes' own heading, or the dialog's label for a group the author left unheaded. */}
            {group.title ?? t('update.notesHighlights')}
          </h3>
          <div className="mt-1 space-y-1.5 text-xs text-muted-foreground">
            {toRuns(group.blocks).map((run, runIndex) =>
              run.kind === 'list' ? (
                <ol key={runIndex} className="list-decimal space-y-1 pl-5">
                  {run.entries.map((entry, entryIndex) => (
                    <EntryItem key={entryIndex} entry={entry} />
                  ))}
                </ol>
              ) : (
                <p
                  key={runIndex}
                  data-testid="release-note-paragraph"
                  className="min-w-0 whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]"
                >
                  <SpanList spans={run.spans} />
                </p>
              )
            )}
          </div>
        </section>
      ))}
    </div>
  )
}

export { UpdateReleaseNotes }
