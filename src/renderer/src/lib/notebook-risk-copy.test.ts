import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { zh } from '@/i18n/zh'
import type { NotebookRunRiskReceipt } from '../../../shared/notebook'

import {
  notebookRunDeclinedNotice,
  notebookRiskLines,
  notebookRiskTitle
} from './notebook-risk-copy'

const translatorFor =
  (dictionary: Record<string, string>) =>
  (key: string): string =>
    dictionary[key] ?? key

const receipt = (overrides: Partial<NotebookRunRiskReceipt> = {}): NotebookRunRiskReceipt => ({
  verdict: 'review',
  ruleSetVersion: 'notebook-run-risk:v1',
  codeHash: 'a'.repeat(64),
  hits: [
    {
      ruleId: 'fs-delete',
      ruleVersion: 'v1',
      lines: [2],
      excerpts: ["shutil.rmtree('/tmp/x')"]
    }
  ],
  ...overrides
})

describe('notebook risk copy', () => {
  it("names the rule in the reader's words and keeps the id in the line", () => {
    const t = translatorFor(en)
    expect(notebookRiskTitle(t, receipt())).toBe(
      'Review this notebook run: deletes files at line 2'
    )
    expect(notebookRiskLines(t, receipt())).toEqual([
      "deletes files (fs-delete) — line 2: shutil.rmtree('/tmp/x')"
    ])
  })

  it('names every rule when more than one fired', () => {
    const t = translatorFor(en)
    const many = receipt({
      hits: [
        { ruleId: 'fs-delete', ruleVersion: 'v1', lines: [1], excerpts: ["os.remove('a')"] },
        { ruleId: 'shell-exec', ruleVersion: 'v1', lines: [4], excerpts: ['!ls'] }
      ]
    })
    expect(notebookRiskTitle(t, many)).toBe(
      'Review this notebook run: 2 rules fired (deletes files, runs shell commands)'
    )
    expect(notebookRiskLines(t, many)).toHaveLength(2)
  })

  it('lists several lines of one rule together', () => {
    const t = translatorFor(en)
    const lines = receipt({
      hits: [{ ruleId: 'fs-overwrite', ruleVersion: 'v1', lines: [3, 7], excerpts: ['a', 'b'] }]
    })
    expect(notebookRiskLines(t, lines)).toEqual([
      'overwrites files (fs-overwrite) — lines 3, 7: a | b'
    ])
  })

  it('has nothing to show for an allow', () => {
    const t = translatorFor(en)
    expect(notebookRiskTitle(t, receipt({ verdict: 'allow', hits: [] }))).toBeUndefined()
    expect(notebookRiskLines(t, receipt({ verdict: 'allow', hits: [] }))).toEqual([])
  })

  it('reads as Chinese in zh, and the id survives translation', () => {
    const t = translatorFor(zh as unknown as Record<string, string>)
    const title = notebookRiskTitle(t, receipt())
    expect(title).toContain('笔记本')
    expect(title).not.toContain('{')
    const line = notebookRiskLines(t, receipt())[0]
    expect(line).toContain('fs-delete')
    expect(line).toContain("shutil.rmtree('/tmp/x')")
  })

  it('leaves no unfilled placeholder in any language it is given', () => {
    for (const [name, dictionary] of [
      ['en', en],
      ['zh', zh]
    ] as const) {
      const t = translatorFor(dictionary as unknown as Record<string, string>)
      const many = receipt({
        hits: [
          { ruleId: 'large-allocation', ruleVersion: 'v1', lines: [1], excerpts: ['x'] },
          { ruleId: 'fs-overwrite', ruleVersion: 'v1', lines: [2, 3], excerpts: ['y', 'z'] }
        ]
      })
      expect(notebookRiskTitle(t, many), name).not.toContain('{')
      for (const line of notebookRiskLines(t, many)) expect(line, name).not.toContain('{')
    }
  })

  it("re-says a declined run in the reader's words and names the rules like the card did", () => {
    const t = translatorFor(en)
    expect(notebookRunDeclinedNotice(t, 'Notebook run declined: fs-delete')).toBe(
      'Notebook run declined: deletes files (fs-delete) — no code was executed.'
    )
  })

  it('says it in Chinese and keeps every machine id in the line', () => {
    const t = translatorFor(zh as unknown as Record<string, string>)
    const notice = notebookRunDeclinedNotice(t, 'Notebook run declined: fs-delete, shell-exec')

    expect(notice).toContain('笔记本')
    expect(notice).toContain('fs-delete')
    expect(notice).toContain('shell-exec')
    expect(notice).not.toContain('{')
  })

  it('keeps a rule id it does not know rather than dropping it from the refusal', () => {
    const t = translatorFor(en)
    expect(notebookRunDeclinedNotice(t, 'Notebook run declined: some-future-rule')).toContain(
      'some-future-rule'
    )
  })

  it('has nothing to say about any other failure', () => {
    const t = translatorFor(en)
    expect(notebookRunDeclinedNotice(t, 'ENOENT: no such file or directory')).toBeUndefined()
  })
})
