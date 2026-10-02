import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  JOURNAL_MERGE_REFUSALS,
  JOURNAL_MERGE_REFUSAL_LABEL_KEYS,
  isJournalMergeOutcome,
  journalDisplayName,
  type JournalMergeResult
} from './journal-merge'

// The refusals a merge can produce are a judgement the window has to be able to READ. Two things can go wrong
// silently here, so both are pinned: a new refusal that nothing translates (the window would print a raw code)
// and a label map that drifts from the refusal list it claims to cover.
describe('journal merge refusals', () => {
  it('labels every refusal exactly once', () => {
    const labelled = Object.keys(JOURNAL_MERGE_REFUSAL_LABEL_KEYS).sort()
    expect(labelled).toEqual([...JOURNAL_MERGE_REFUSALS].sort())

    const keys = Object.values(JOURNAL_MERGE_REFUSAL_LABEL_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys)
      expect(key.startsWith('references.journalMetrics.merge.refusal.')).toBe(true)
  })

  it('has a real translation for every refusal label in all nine dictionaries', () => {
    // A source-read guard, on purpose: a key that exists only in the English file would reach eight languages
    // as the raw key, which is exactly the untranslated surface this project refuses to ship.
    const root = join(__dirname, '..', 'renderer', 'src', 'i18n')
    const languages = ['en', 'zh', 'zh-Hant', 'ja', 'ko', 'de', 'es', 'fr', 'ru']

    for (const language of languages) {
      const source = readFileSync(join(root, `${language}.ts`), 'utf8')
      for (const key of Object.values(JOURNAL_MERGE_REFUSAL_LABEL_KEYS)) {
        // Comparing the whole object rather than a bare boolean keeps the failing language and key in the
        // assertion output instead of a nameless `false`.
        expect({ language, key, present: source.includes(`'${key}'`) }).toEqual({
          language,
          key,
          present: true
        })
      }
    }
  })
})

describe('journalDisplayName', () => {
  it('prefers the spelling the source used, and falls back to the normalized form', () => {
    expect(journalDisplayName({ normalizedName: 'nature', displayName: 'Nature' })).toBe('Nature')
    expect(journalDisplayName({ normalizedName: 'nature', displayName: null })).toBe('nature')
    expect(journalDisplayName({ normalizedName: 'nature' })).toBe('nature')
    // A blank spelling is not a name: it must not turn the cell empty.
    expect(journalDisplayName({ normalizedName: 'nature', displayName: '   ' })).toBe('nature')
  })
})

describe('isJournalMergeOutcome', () => {
  it('separates what the store did from why it refused', () => {
    const merged: JournalMergeResult = {
      ok: true,
      sourceJournalId: 's',
      targetJournalId: 't',
      alias: 'nature london',
      movedMetrics: 1,
      movedReferences: 0,
      movedAliases: 0
    }
    const refused: JournalMergeResult = {
      ok: false,
      reason: 'alias-conflict',
      detail: 'the name belongs to another journal'
    }

    expect(isJournalMergeOutcome(merged)).toBe(true)
    expect(isJournalMergeOutcome(refused)).toBe(false)
  })
})
