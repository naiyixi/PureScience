import type { KnowledgeSource, KnowledgeSourceKind } from '../../../../shared/knowledge'

// Filtering and sorting for the Knowledge panel's source list. Kept import-free and pure so it can be
// tested without the component, its store or a window.
//
// Why this module exists at all: the list is paginated twenty rows at a time, and a register with a few
// hundred sources is scannable only if a reader can narrow it and reorder it. Both are done over the rows
// the panel already holds — no new channel, no server-side query, and nothing the model's tools see changes.

/** `all` is a real option, not an empty string: it reads as "no kind narrowing" rather than as "match nothing". */
export type KnowledgeKindFilter = 'all' | KnowledgeSourceKind

/** `store` is the register's own order and the default; the other two are explicit reorderings of it. */
export type KnowledgeSortKind = 'store' | 'label' | 'bytes'

export type KnowledgeSourceView = {
  text: string
  kind: KnowledgeKindFilter
  sort: KnowledgeSortKind
}

const normalize = (value: string): string => value.trim().toLocaleLowerCase()

// The needle is matched against the three identifiable strings a row actually shows — its label, where it
// came from, and (for a URL) where the request landed. Matching a field the row does not print would put rows
// on screen with no visible reason to be there.
const matchesText = (source: KnowledgeSource, needle: string): boolean => {
  if (!needle) return true
  return [source.label, source.location, source.finalUrl ?? ''].some((field) =>
    normalize(field).includes(needle)
  )
}

// Case-insensitive with numeric runs compared as numbers, so `note-2` sorts before `note-10` rather than
// after it. Mirrors the marketplace listing's name order (`specialist-marketplace-sort.ts`) instead of
// introducing a second opinion about what "by name" means in this app.
const compareByLabel = (left: KnowledgeSource, right: KnowledgeSource): number =>
  left.label.localeCompare(right.label, undefined, { sensitivity: 'base', numeric: true })

// Largest first: the rows a reader is usually looking for when sorting by size are the ones that took the
// most room. `bytes` comes from the fingerprint the store computed, not from anything this module measures.
const compareByBytes = (left: KnowledgeSource, right: KnowledgeSource): number =>
  right.fingerprint.bytes - left.fingerprint.bytes

const comparatorFor = (
  sort: KnowledgeSortKind
): ((left: KnowledgeSource, right: KnowledgeSource) => number) | undefined => {
  if (sort === 'label') return compareByLabel
  if (sort === 'bytes') return compareByBytes
  // `store` deliberately returns no comparator: the register's order is information (it is the order sources
  // were added), and re-deriving it here would be a second, silently different notion of "registration order".
  return undefined
}

/**
 * The rows the panel should render, in the order it should render them.
 *
 * Filtering happens before sorting so a sort never has to reason about rows nobody asked for, and ties keep
 * the register's order — two sources with the same label or the same byte count must not swap places between
 * renders for no reason a reader could see.
 */
export const filterAndSortKnowledgeSources = (
  sources: readonly KnowledgeSource[],
  view: KnowledgeSourceView
): KnowledgeSource[] => {
  const needle = normalize(view.text)
  const kept = sources.filter(
    (source) => (view.kind === 'all' || source.kind === view.kind) && matchesText(source, needle)
  )
  const compare = comparatorFor(view.sort)
  if (!compare) return kept
  return kept
    .map((source, index) => ({ source, index }))
    .sort((left, right) => {
      const compared = compare(left.source, right.source)
      return compared !== 0 ? compared : left.index - right.index
    })
    .map(({ source }) => source)
}

/**
 * Whether the view is narrowing the list at all. The panel uses this to decide whether to print a count:
 * "showing 3 of 128" is a fact about a filter, and printing it when nothing is filtered would be noise that
 * teaches a reader to ignore the line.
 */
export const isNarrowed = (view: KnowledgeSourceView): boolean =>
  view.text.trim().length > 0 || view.kind !== 'all'
