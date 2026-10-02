// Journal aliases and the explicit merge (R2-U4), as a contract.
//
// One rule shapes this whole slice: a name that merely looks like another name is not evidence that the two
// are the same journal. Automatically merging `Nature` and `Nature Communications` would invent a fact —
// every number of one journal would be attributed to the other — so aliases exist ONLY as the record of a
// merge a person asked for, and every refusal below is a named reason rather than a silent rewrite.
//
// The result is a discriminated union instead of a thrown error for exactly that reason: refusing to merge
// two journals is a JUDGEMENT the user must be able to read (which name collided, which id was missing), not
// an exception. Only a failure that is not a judgement (the engine is down) propagates.

export const JOURNAL_MERGE_REFUSALS = [
  // A journal cannot be merged into itself: that is not a merge, it is a no-op the caller must not confuse
  // with success.
  'self-merge',
  'source-not-found',
  'target-not-found',
  // The source's normalized name is already an alias of a DIFFERENT journal. Overwriting that alias would
  // silently re-attribute an existing name, so the merge is refused with the name and the id it collides
  // with; the user resolves the collision explicitly (merge that one too) or not at all.
  'alias-conflict'
] as const

export type JournalMergeRefusal = (typeof JOURNAL_MERGE_REFUSALS)[number]

export type JournalMergeRequest = {
  sourceJournalId: string
  targetJournalId: string
}

// What the store actually did, so the surface can report the merge instead of merely claiming it. The counts
// are the rows re-attributed — they are the merge's only observable effect besides the alias row.
export type JournalMergeOutcome = {
  ok: true
  sourceJournalId: string
  targetJournalId: string
  // The source's normalized name, now an alias of the target: this is what makes the old spelling keep
  // resolving to the same journal (the "更名" half of the slice).
  alias: string
  movedMetrics: number
  movedReferences: number
  movedAliases: number
}

export type JournalMergeRefusalResult = {
  ok: false
  reason: JournalMergeRefusal
  // A sentence the surface can show as-is: it names the conflicting name / the missing id. Never a stack.
  detail: string
}

export type JournalMergeResult = JournalMergeOutcome | JournalMergeRefusalResult

export const isJournalMergeOutcome = (result: JournalMergeResult): result is JournalMergeOutcome =>
  result.ok

// Exhaustive on purpose: a refusal added to the store without a label here fails to compile, so a new
// refusal cannot reach the window as an untranslated code. Values are the i18n keys the panel renders.
export const JOURNAL_MERGE_REFUSAL_LABEL_KEYS: Readonly<Record<JournalMergeRefusal, string>> =
  Object.freeze({
    'self-merge': 'references.journalMetrics.merge.refusal.selfMerge',
    'source-not-found': 'references.journalMetrics.merge.refusal.sourceNotFound',
    'target-not-found': 'references.journalMetrics.merge.refusal.targetNotFound',
    'alias-conflict': 'references.journalMetrics.merge.refusal.aliasConflict'
  })

// The name a surface shows for a journal: the source's own spelling when the record has one, otherwise the
// normalized form. Never an empty string — a record with no name at all would be a record the store refuses
// to create.
export const journalDisplayName = (journal: {
  normalizedName: string
  displayName?: string | null
}): string => journal.displayName?.trim() || journal.normalizedName
