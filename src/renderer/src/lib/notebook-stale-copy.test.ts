import { describe, expect, it } from 'vitest'

import { de } from '@/i18n/de'
import { en } from '@/i18n/en'
import { es } from '@/i18n/es'
import { fr } from '@/i18n/fr'
import { ja } from '@/i18n/ja'
import { ko } from '@/i18n/ko'
import { ru } from '@/i18n/ru'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-Hant'
import type { NotebookStaleReason } from '../../../shared/run-alias-lineage'

import { notebookStaleReasonText } from './notebook-stale-copy'

const translatorFor =
  (dictionary: Record<string, string | undefined>) =>
  (key: string): string =>
    dictionary[key] ?? key

const reason = (overrides: Partial<NotebookStaleReason> = {}): NotebookStaleReason => ({
  kind: 'alias-mutation',
  recipeVersion: 'notebook-alias-lineage:v1',
  producerRunId: 'r1',
  producerContentHash: 'a'.repeat(64),
  variable: 'df',
  laterRunId: 'r4',
  via: 'frame',
  aliasChain: ['frame'],
  mutation: { kind: 'inplace-call', line: 7, excerpt: 'frame.dropna(inplace=True)' },
  ...overrides
})

describe('notebook stale reason copy', () => {
  it("names the alias and the line in the reader's words", () => {
    expect(notebookStaleReasonText(translatorFor(en), reason())).toBe(
      '“df” was changed in place by a later run through the alias “frame” (line 7)'
    )
    expect(notebookStaleReasonText(translatorFor(zh), reason())).toBe(
      '「df」已被后续运行经别名「frame」就地修改（第 7 行）'
    )
  })

  it('says a direct in-place change without inventing an alias', () => {
    const direct = reason({
      kind: 'direct-mutation',
      via: 'df',
      aliasChain: [],
      mutation: { kind: 'subscript-write', line: 3, excerpt: "df['x'] = 1" }
    })
    expect(notebookStaleReasonText(translatorFor(en), direct)).toBe(
      '“df” was changed in place by a later run (line 3)'
    )
    expect(notebookStaleReasonText(translatorFor(zh), direct)).toBe(
      '「df」已被后续运行就地修改（第 3 行）'
    )
  })

  it('says a rewrite without claiming a line, because a rewrite has no site in that sense', () => {
    const rewrite = reason({ kind: 'name-rewrite', via: 'df', aliasChain: [], mutation: undefined })
    expect(notebookStaleReasonText(translatorFor(en), rewrite)).toBe(
      '“df” was written again by a later run'
    )
    expect(notebookStaleReasonText(translatorFor(zh), rewrite)).toBe('「df」已被后续运行重写')
  })

  it('renders every kind with every placeholder filled in all nine languages', () => {
    const dictionaries: Record<string, Record<string, string | undefined>> = {
      en,
      zh,
      'zh-Hant': zhHant,
      ja,
      ko,
      de,
      fr,
      es,
      ru
    }
    const kinds: NotebookStaleReason[] = [
      reason(),
      reason({ kind: 'direct-mutation', via: 'df', aliasChain: [] }),
      reason({ kind: 'name-rewrite', via: 'df', aliasChain: [], mutation: undefined })
    ]

    for (const [language, dictionary] of Object.entries(dictionaries)) {
      const t = translatorFor(dictionary)
      for (const kind of kinds) {
        const text = notebookStaleReasonText(t, kind)
        expect(text, `${language}/${kind.kind} is missing its copy`).toBeDefined()
        expect(text, `${language}/${kind.kind} left a placeholder unfilled`).not.toContain('{')
      }
    }
  })

  it('keeps the reason distinct from the bare marker in every language', () => {
    for (const dictionary of [en, zh, zhHant, ja, ko, de, fr, es, ru]) {
      const marker = dictionary['ws.notebookStale']
      const text = notebookStaleReasonText(translatorFor(dictionary), reason())
      expect(marker).toBeDefined()
      expect(text).not.toBe(marker)
    }
  })
})
