import type { TranslationKey } from '@/i18n'

// The five kinds the library knows by name get a label; any other kind keeps the store's own word, because
// inventing a translation for a kind nobody defined is how a vocabulary drifts.
//
// This is its own module rather than a constant beside the table because the import form offers the same five
// names as suggestions. Two copies of the list would let the table label a kind the form cannot suggest (or
// the reverse) and nothing would fail — a reader would just see a kind they cannot pick.
export const KIND_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = Object.freeze({
  'impact-factor': 'references.journalMetrics.kind.impactFactor',
  'jcr-quartile': 'references.journalMetrics.kind.jcrQuartile',
  'cas-partition': 'references.journalMetrics.kind.casPartition',
  'cas-top': 'references.journalMetrics.kind.casTop',
  'acceptance-rate': 'references.journalMetrics.kind.acceptanceRate'
} as Record<string, TranslationKey>)

// The canonical kind tokens, in label order. These are the store's own words (what a claim's `kind` holds and
// what the panel's columns are keyed by), NOT the translated labels — the form suggests a token, and the
// table prints its label.
export const JOURNAL_METRIC_KINDS: readonly string[] = Object.freeze(Object.keys(KIND_LABEL_KEYS))
