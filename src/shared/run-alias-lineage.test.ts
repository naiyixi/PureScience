import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  ALIAS_LINEAGE_RECIPE,
  ALIAS_LINEAGE_RECIPE_VERSION,
  analyzeNotebookScriptStructure,
  computeNotebookStaleReasons,
  type AliasLineageRun
} from './run-alias-lineage'
import { buildArtifactAliasLineage } from './artifact-alias-lineage'
import { computeStaleRunIds, extractVariablesWritten } from './run-dependencies'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// A run fixture that carries the content hash the app itself would have persisted: the test computes
// it here, independently of the module, so a hash the module invents cannot pass. The recorded writer
// list comes from the same extractor the app uses, so the fixtures cannot drift from real records.
const run = (
  runId: string,
  script: string,
  options: { status?: string; variablesWritten?: string[]; withReceipt?: boolean } = {}
): AliasLineageRun => ({
  runId,
  status: options.status ?? 'completed',
  script,
  variablesWritten: options.variablesWritten ?? extractVariablesWritten(script),
  ...(options.withReceipt === false ? {} : { riskReview: { codeHash: sha256(script) } })
})

describe('analyzeNotebookScriptStructure', () => {
  it('reports a plain reference copy as an alias binding', () => {
    const structure = analyzeNotebookScriptStructure('b = a\nd = c + 1')
    expect(structure.aliases).toEqual([{ name: 'b', target: 'a', line: 1, excerpt: 'b = a' }])
  })

  it('reports R-style binding and ignores self-assignment', () => {
    const structure = analyzeNotebookScriptStructure('x <- base\ny = y')
    expect(structure.aliases.map((alias) => [alias.name, alias.target])).toEqual([['x', 'base']])
  })

  it('does not call a copy, an index, a call or a comparison an alias', () => {
    const structure = analyzeNotebookScriptStructure(
      ['b = a.copy()', 'c = a[0]', 'e = a.values', 'f = a + 1', 'g == a', 'h = [a]'].join('\n')
    )
    expect(structure.aliases).toEqual([])
  })

  it('reports subscript writes, augmented writes and subscript deletes', () => {
    const structure = analyzeNotebookScriptStructure(
      ["meta['stage'] = 'qc'", "acc['r'] += 1", "del cache['tmp']"].join('\n')
    )
    expect(structure.mutations).toEqual([
      { via: 'meta', kind: 'subscript-write', line: 1, excerpt: "meta['stage'] = 'qc'" },
      { via: 'acc', kind: 'subscript-augmented-write', line: 2, excerpt: "acc['r'] += 1" },
      { via: 'cache', kind: 'subscript-delete', line: 3, excerpt: "del cache['tmp']" }
    ])
  })

  it('reports unconditional mutators and only opt-in ones that say inplace=True', () => {
    const structure = analyzeNotebookScriptStructure(
      ['frames.append(f)', 'values.sort()', 'clean = df.dropna()', 'df.dropna(inplace=True)'].join(
        '\n'
      )
    )
    expect(
      structure.mutations.map((mutation) => [mutation.via, mutation.kind, mutation.line])
    ).toEqual([
      ['frames', 'inplace-call', 1],
      ['values', 'inplace-call', 2],
      ['df', 'inplace-call', 4]
    ])
  })

  it('does not read a docstring or a comment as this run’s own changes', () => {
    const script = [
      'brief = compute()',
      '"""',
      'b = a',
      "meta['x'] = 1",
      '"""',
      '# df.dropna(inplace=True)',
      "meta['y'] = 2"
    ].join('\n')
    const structure = analyzeNotebookScriptStructure(script)
    expect(structure.aliases).toEqual([])
    expect(structure.mutations).toEqual([
      { via: 'meta', kind: 'subscript-write', line: 7, excerpt: "meta['y'] = 2" }
    ])
  })

  it('names the rule set version it applied', () => {
    expect(analyzeNotebookScriptStructure('a = 1').recipeVersion).toBe(ALIAS_LINEAGE_RECIPE_VERSION)
  })
})

describe('computeNotebookStaleReasons', () => {
  it('flags an in-place mutation through an alias — the case the name-level rule cannot see', () => {
    const runs = [run('r1', 'a = [1]'), run('r2', 'b = a\nb.append(2)')]
    expect(computeStaleRunIds(runs).size).toBe(0)

    const reasons = computeNotebookStaleReasons(runs)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatchObject({
      kind: 'alias-mutation',
      producerRunId: 'r1',
      variable: 'a',
      laterRunId: 'r2',
      via: 'b',
      aliasChain: ['b'],
      mutation: { kind: 'inplace-call', line: 2, excerpt: 'b.append(2)' }
    })
  })

  it('follows a chain of bindings to the name the object came from', () => {
    const runs = [run('r1', 'a = {}'), run('r2', 'b = a\nc = b'), run('r3', "c['k'] = 1")]
    const reasons = computeNotebookStaleReasons(runs)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatchObject({
      kind: 'alias-mutation',
      variable: 'a',
      via: 'c',
      aliasChain: ['c', 'b'],
      mutation: { kind: 'subscript-write', line: 1 }
    })
  })

  it('flags a direct in-place mutation, with no alias in the chain', () => {
    const runs = [run('r1', 'acc = {}'), run('r2', "acc['r'] = 1")]
    const reasons = computeNotebookStaleReasons(runs)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatchObject({
      kind: 'direct-mutation',
      variable: 'acc',
      via: 'acc',
      aliasChain: []
    })
  })

  it('never treats a copy as an alias', () => {
    const runs = [run('r1', 'a = [1]'), run('r2', 'b = a.copy()\nb.append(2)')]
    expect(computeNotebookStaleReasons(runs)).toEqual([])
  })

  it('keeps the name-level rewrite as the reason when a later run also rewrote the name', () => {
    const runs = [run('r1', 'a = [1]'), run('r2', 'a = [9]\na.append(3)')]
    const reasons = computeNotebookStaleReasons(runs)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatchObject({ kind: 'name-rewrite', variable: 'a', laterRunId: 'r2' })
    expect(reasons[0]?.mutation).toBeUndefined()
  })

  it('ignores a later run that did not complete', () => {
    const runs = [
      run('r1', 'a = [1]'),
      run('r2', 'b = a\nb.append(2)', { status: 'failed' }),
      run('r3', 'noise = 1')
    ]
    expect(computeNotebookStaleReasons(runs)).toEqual([])
  })

  it('reports only the earliest later change for one producing run', () => {
    const runs = [run('r1', 'a = [1]'), run('r2', 'b = a\nb.append(2)'), run('r3', 'b.append(3)')]
    const reasons = computeNotebookStaleReasons(runs)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]?.laterRunId).toBe('r2')
  })

  it('drops an alias when its target is rebound later, and follows the rebinding run instead', () => {
    // `b = a` bound before `a` was reassigned no longer identifies the value `a` holds now; the run
    // that reassigned it is the one to name. The alias binding is therefore dropped, not carried.
    const runs = [
      run('r1', 'a = [1]'),
      run('r2', 'b = a'),
      run('r3', 'a = [9]'),
      run('r4', 'a.append(7)')
    ]
    const reasons = computeNotebookStaleReasons(runs)
    expect(reasons.map((reason) => [reason.producerRunId, reason.kind, reason.laterRunId])).toEqual(
      [
        ['r1', 'name-rewrite', 'r3'],
        ['r3', 'direct-mutation', 'r4']
      ]
    )
  })

  it('names a missing content hash instead of computing one', () => {
    const runs = [run('r1', 'a = [1]', { withReceipt: false }), run('r2', 'b = a\nb.append(2)')]
    expect(computeNotebookStaleReasons(runs)[0]?.producerContentHash).toBe('not-recorded')
  })

  it('ignores records that carry a malformed hash rather than echoing it', () => {
    const runs: AliasLineageRun[] = [
      {
        runId: 'r1',
        status: 'completed',
        script: 'a = [1]',
        variablesWritten: ['a'],
        riskReview: { codeHash: 'nope' }
      },
      { runId: 'r2', status: 'completed', script: 'b = a\nb.append(2)', variablesWritten: ['b'] }
    ]
    expect(computeNotebookStaleReasons(runs)[0]?.producerContentHash).toBe('not-recorded')
  })

  // The read model attaches this for records written before the receipt existed (v2.1.0, batch B). The
  // test computes the hash itself, so a module that echoed or invented one could not pass.
  it('reads the hash a reader recomputed for a record that predates the receipt', () => {
    const script = 'a = [1, 2]'
    const runs: AliasLineageRun[] = [
      {
        runId: 'r1',
        status: 'completed',
        script,
        variablesWritten: ['a'],
        sourceContentHash: { value: sha256(script) }
      },
      { runId: 'r2', status: 'completed', script: 'b = a\nb.append(3)', variablesWritten: ['b'] }
    ]
    expect(computeNotebookStaleReasons(runs)[0]?.producerContentHash).toBe(sha256(script))
  })

  it('prefers the run’s own receipt over a recomputed hash, so one row never quotes two hashes', () => {
    const script = 'a = [1, 2]'
    const runs: AliasLineageRun[] = [
      {
        runId: 'r1',
        status: 'completed',
        script,
        variablesWritten: ['a'],
        riskReview: { codeHash: sha256(script) },
        sourceContentHash: { value: 'c'.repeat(64) }
      },
      { runId: 'r2', status: 'completed', script: 'b = a\nb.append(3)', variablesWritten: ['b'] }
    ]
    expect(computeNotebookStaleReasons(runs)[0]?.producerContentHash).toBe(sha256(script))
  })

  it('names a malformed recomputed hash as missing instead of echoing it', () => {
    const runs: AliasLineageRun[] = [
      {
        runId: 'r1',
        status: 'completed',
        script: 'a = [1]',
        variablesWritten: ['a'],
        sourceContentHash: { value: 'not-a-hash' }
      },
      { runId: 'r2', status: 'completed', script: 'b = a\nb.append(2)', variablesWritten: ['b'] }
    ]
    expect(computeNotebookStaleReasons(runs)[0]?.producerContentHash).toBe('not-recorded')
  })
})

describe('the published recipe is what the row actually carries', () => {
  it('carries the sha256 of the producing run’s source, recomputable by hand', () => {
    const script = 'a = [1, 2]'
    // Written the way a third party would: hash the recorded source, compare with the row.
    const independent = createHash('sha256').update(script, 'utf8').digest('hex')
    const runs = [run('r1', script), run('r2', 'b = a\nb.append(3)')]

    const reason = computeNotebookStaleReasons(runs)[0]
    expect(reason?.producerContentHash).toBe(independent)
    expect(reason?.recipeVersion).toBe(ALIAS_LINEAGE_RECIPE_VERSION)
  })

  it('states the hash and the rule set version the row is recomputed with', () => {
    expect(ALIAS_LINEAGE_RECIPE).toContain('sha256(utf8 cell source)')
    expect(ALIAS_LINEAGE_RECIPE).toContain(ALIAS_LINEAGE_RECIPE_VERSION)
  })

  it('derives every field of a row from the run records alone', () => {
    const producing = 'a = [1]'
    const mutating = 'b = a\nb.append(2)'
    const runs = [run('r1', producing), run('r2', mutating)]
    const reason = computeNotebookStaleReasons(runs)[0]

    // Each field is present in run.json: r1.script / r1.riskReview.codeHash / r1.variablesWritten,
    // and the later run's own script line. Nothing in the row needs state the app keeps privately.
    expect(reason).toBeDefined()
    expect(Object.keys(reason ?? {}).sort()).toEqual(
      [
        'aliasChain',
        'kind',
        'laterRunId',
        'mutation',
        'producerContentHash',
        'producerRunId',
        'recipeVersion',
        'variable',
        'via'
      ].sort()
    )
    expect(runs[1]?.script?.split('\n')[1]).toBe(reason?.mutation?.excerpt)
  })
})

// B2-3: the projection the artifact provenance panel reads. The analysis is the module's own — these cases
// pin the SCOPING (a Version has one producing run, so only that run's reasons are its lineage) and that a
// row stays recomputable: the hash travels with it, and an absent receipt is named rather than invented.
describe('buildArtifactAliasLineage', () => {
  it('scopes the lineage to the producing run and keeps the chain, the site and the hash', () => {
    const producerScript = 'table = load()\nview = table'
    const runs = [
      run('run-1', producerScript),
      run('run-2', 'view.drop(columns=["x"], inplace=True)'),
      run('run-3', 'total = table.sum()')
    ]
    const lineage = buildArtifactAliasLineage({ producerRunId: 'run-1', runs })
    expect(lineage.state).toBe('available')
    if (lineage.state !== 'available') return

    expect(lineage.recipeVersion).toBe(ALIAS_LINEAGE_RECIPE_VERSION)
    expect(lineage.producerRunId).toBe('run-1')
    // run-3 wrote `total`, which the producing run never wrote: not this Version's lineage.
    expect(lineage.rows.map((row) => row.variable)).not.toContain('total')
    expect(lineage.rows.length).toBeGreaterThan(0)
    const row = lineage.rows[0]
    expect(row.producerRunId).toBe('run-1')
    expect(row.laterRunId).toBe('run-2')
    // The projection adds scoping and carries the engine's own fields through unchanged: what a
    // reason MEANS stays the engine's business, so a row cannot drift from what the notebook shows.
    const engineReasons = computeNotebookStaleReasons(runs).filter(
      (reason) => reason.producerRunId === 'run-1'
    )
    expect(lineage.rows.map((item) => item.variable)).toEqual(
      engineReasons.map((reason) => reason.variable)
    )
    expect(lineage.rows[0].aliasChain).toEqual(engineReasons[0].aliasChain)
    expect(lineage.rows[0].kind).toBe(engineReasons[0].kind)
    expect(lineage.rows[0].mutation).toEqual(engineReasons[0].mutation)
    // The hash is the producing run's own, computed here from its source rather than trusted.
    expect(row.producerContentHash).toBe(sha256(producerScript))
  })

  it('reports an available, empty lineage when no later run changed what that run wrote', () => {
    const lineage = buildArtifactAliasLineage({
      producerRunId: 'run-1',
      runs: [run('run-1', 'a = 1')]
    })
    expect(lineage).toMatchObject({ state: 'available', rows: [] })
  })

  it('names an absent receipt instead of inventing a hash', () => {
    const runs = [
      run('run-1', 'table = load()\nview = table', { withReceipt: false }),
      run('run-2', 'view.drop(columns=["x"], inplace=True)')
    ]
    const lineage = buildArtifactAliasLineage({ producerRunId: 'run-1', runs })
    if (lineage.state !== 'available') throw new Error('expected an available lineage')
    expect(lineage.rows[0].producerContentHash).toBe('not-recorded')
  })
})
