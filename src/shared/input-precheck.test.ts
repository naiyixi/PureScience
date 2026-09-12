// Input pre-check: which paths a task names, which of them do not exist, and what to say about it.
import { describe, expect, it } from 'vitest'

import {
  INPUT_PRECHECK_SYSTEM_PROMPT_APPEND,
  assessInputPaths,
  buildMissingInputNotice,
  extractInputPathCandidates
} from './input-precheck'

describe('input pre-check', () => {
  it('finds the data files and paths a task names', () => {
    const candidates = extractInputPathCandidates(
      '请分析 sim_2024_control.csv 和 sim_2024_treat.csv，参考 data/notes.tsv、~/refs/pdb/1abc.pdb 与 /mnt/raw/x.h5'
    )

    expect(candidates).toEqual([
      'sim_2024_control.csv',
      'sim_2024_treat.csv',
      'data/notes.tsv',
      '~/refs/pdb/1abc.pdb',
      '/mnt/raw/x.h5'
    ])
  })

  it('ignores things that are not inputs', () => {
    const candidates = extractInputPathCandidates(
      'See https://example.org/data.csv and p < 0.05, compare against model v1.2.3 (Zhang 2024). 结果见 report.md'
    )

    // A URL is a source, not a local file; a version and a p-value are not paths; and a bare report name
    // is treated as an OUTPUT the task will write, not an input it needs — flagging it would report a
    // file the user is about to create as missing.
    expect(candidates).toEqual([])
  })

  it('still checks a path-shaped markdown or config file', () => {
    // Anything written with a path is checked regardless of extension, because the user pointed at it.
    expect(extractInputPathCandidates('先读 docs/notes.md 和 config/params.yaml')).toEqual([
      'docs/notes.md',
      'config/params.yaml'
    ])
  })

  it('strips the sentence punctuation that follows a path', () => {
    expect(extractInputPathCandidates('输入是 counts.csv，还有 sub/table.xlsx。')).toEqual([
      'counts.csv',
      'sub/table.xlsx'
    ])
  })

  it('separates the paths that exist from the ones that do not', () => {
    const result = assessInputPaths(
      '分析 sim_a.csv 与 sim_b.csv，用 data/params.json',
      (path) => path === 'data/params.json'
    )

    expect(result.present).toEqual(['data/params.json'])
    expect(result.missing).toEqual(['sim_a.csv', 'sim_b.csv'])
  })

  it('says nothing when every input is present, and names the gaps when they are not', () => {
    expect(buildMissingInputNotice({ present: ['a.csv'], missing: [] })).toBe('')

    const notice = buildMissingInputNotice({ present: [], missing: ['sim_a.csv'] })
    expect(notice).toContain('<missing_inputs>')
    expect(notice).toContain('sim_a.csv')
    expect(notice).toContain('first reply')
  })

  it('tells every session to check inputs before planning', () => {
    expect(INPUT_PRECHECK_SYSTEM_PROMPT_APPEND).toContain('<input_precheck>')
    expect(INPUT_PRECHECK_SYSTEM_PROMPT_APPEND).toContain('FIRST reply')
    expect(INPUT_PRECHECK_SYSTEM_PROMPT_APPEND).toContain('final report')
  })
})
