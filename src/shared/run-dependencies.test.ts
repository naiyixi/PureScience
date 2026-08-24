import { describe, expect, it } from 'vitest'

import { computeStaleRunIds, extractVariablesWritten } from './run-dependencies'

describe('extractVariablesWritten', () => {
  it('collects assignment targets across python and R syntax', () => {
    const script = [
      'import scanpy as sc',
      'adata = sc.read_h5ad("pbmc.h5ad")',
      'adata.obs["batch"] = ...', // attribute/subscript assignment still writes the base name
      'for c in adata.obs:',
      '    pass',
      'counts <- as.data.frame(exprs)',
      'del temp',
      '# a comment = ignored',
      'plt.figure()',
      'result = adata[:, :500]'
    ].join('\n')
    const written = extractVariablesWritten(script)
    expect(written).toContain('adata')
    expect(written).toContain('counts')
    expect(written).toContain('temp')
    expect(written).toContain('result')
    expect(written).not.toContain('sc')
    expect(written).not.toContain('plt')
    expect(written).not.toContain('c')
  })

  it('returns an empty list for a script with no assignments', () => {
    expect(extractVariablesWritten('print("hello")')).toEqual([])
    expect(extractVariablesWritten('')).toEqual([])
  })
})

describe('computeStaleRunIds', () => {
  it('marks a run stale when a later completed run rewrites one of its variables', () => {
    const runs = [
      { runId: 'a', status: 'completed', variablesWritten: ['adata', 'fig'] },
      { runId: 'b', status: 'completed', variablesWritten: ['stats'] },
      { runId: 'c', status: 'completed', variablesWritten: ['adata'] }
    ]
    expect([...computeStaleRunIds(runs)]).toEqual(['a'])
  })

  it('does not mark stale when later runs touch different variables', () => {
    const runs = [
      { runId: 'a', status: 'completed', variablesWritten: ['adata'] },
      { runId: 'b', status: 'completed', variablesWritten: ['stats'] }
    ]
    expect(computeStaleRunIds(runs).size).toBe(0)
  })

  it('ignores failed/interrupted later runs', () => {
    const runs = [
      { runId: 'a', status: 'completed', variablesWritten: ['adata'] },
      { runId: 'b', status: 'failed', variablesWritten: ['adata'] }
    ]
    expect(computeStaleRunIds(runs).size).toBe(0)
  })

  it('does not treat a run as stale due to its own writes', () => {
    const runs = [
      { runId: 'a', status: 'completed', variablesWritten: ['x'] },
      { runId: 'b', status: 'completed', variablesWritten: ['y'] },
      { runId: 'c', status: 'completed', variablesWritten: ['z'] }
    ]
    expect(computeStaleRunIds(runs).size).toBe(0)
  })
})
