import { describe, expect, it } from 'vitest'

import {
  applyAccessionLookups,
  deriveFromFigure,
  describeFigureDerivation,
  numericTokensIn,
  type FigureDerivation,
  type FigureTextItem
} from './figure-derivation'
import { figureUnderstandingFor } from './figure-understanding'

const item = (text: string, x = 10, y = 20, width = text.length * 5): FigureTextItem => ({
  text,
  x,
  y,
  width,
  height: 10
})

const derived = (caption: string | undefined, lines: string[]): FigureDerivation =>
  deriveFromFigure({
    understanding: figureUnderstandingFor({
      ...(caption === undefined ? {} : { caption }),
      inFigureText: lines
    }),
    inFigureText: lines.map((line) => item(line))
  })

describe('numericTokensIn', () => {
  it('取数值记号：统计前缀与比较号放行，指标名与取代基记号不放行', () => {
    expect(numericTokensIn('<0.001 p<0.001 n=6')).toEqual(['<0.001', 'p<0.001', 'n=6'])
    expect(numericTokensIn('0.83 1,204 12%')).toEqual(['0.83', '1,204', '12%'])
    expect(numericTokensIn('IC50 (nM)')).toEqual([])
    expect(numericTokensIn('R2')).toEqual([])
    expect(numericTokensIn('concentration')).toEqual([])
  })

  it('整行就是一个数值时也取得到', () => {
    expect(numericTokensIn('6')).toEqual(['6'])
    expect(numericTokensIn('-2.5')).toEqual(['-2.5'])
  })
})

describe('deriveFromFigure — 这一类允许派生什么', () => {
  it('图表：给出图框内的数值，每一项带印着它的那一行的页级几何', () => {
    const derivation = derived('Dose–response curves; error bars show SEM; n = 6.', [
      '0.83',
      'inhibition (%)',
      '<0.001'
    ])

    expect(derivation.kind).toBe('numbers')
    if (derivation.kind !== 'numbers') throw new Error('unreachable')
    expect(derivation.source).toBe('pdf-text-in-bbox')
    expect(derivation.values.map((v) => v.value)).toEqual(['0.83', '<0.001'])
    expect(derivation.values[0]?.line).toBe('0.83')
    expect(derivation.values[0]?.bbox).toEqual({ x: 10, y: 20, width: 20, height: 10 })
  })

  it('图表：图框内没有数值时具名拒答，而不是给一个空列表', () => {
    const derivation = derived('Dose–response curves; error bars show SEM; n = 6.', [
      'concentration'
    ])

    expect(derivation.kind).toBe('refused')
    if (derivation.kind !== 'refused') throw new Error('unreachable')
    expect(derivation.reason).toBe('no-numbers-in-box')
  })

  it('化学结构式：拒答并写明缺的是一台引擎（不许拿描述模型顶替）', () => {
    const derivation = derived('Scheme 2', [])

    expect(derivation.kind).toBe('refused')
    if (derivation.kind !== 'refused') throw new Error('unreachable')
    expect(derivation.reason).toBe('recognizer-unavailable')
    expect(derivation.requires).toContain('引擎')
  })

  it('蛋白结构图：把图上读到的库号带出来，并说明查库那条路还没接', () => {
    const derivation = derived('Figure 3. Overall structure (PDB 6LU7).', [])

    expect(derivation.kind).toBe('refused')
    if (derivation.kind !== 'refused') throw new Error('unreachable')
    expect(derivation.reason).toBe('accession-lookup-not-wired')
    expect(derivation.accessions?.map((a) => `${a.kind}:${a.id}`)).toEqual(['pdb:6LU7'])
  })

  it('蛋白结构图没有库号时同样拒答，但**不**编一个库号出来', () => {
    const derivation = derived('Ribbon diagram of the protein.', [])

    expect(derivation.kind).toBe('refused')
    if (derivation.kind !== 'refused') throw new Error('unreachable')
    expect(derivation.reason).toBe('accession-lookup-not-wired')
    expect(derivation.accessions).toBeUndefined()
  })

  it('通用示意图：拒答并说明需要一台通用描述模型（本类之外不许用它）', () => {
    const derivation = derived('Workflow schematic of the screening pipeline.', [])

    expect(derivation.kind).toBe('refused')
    if (derivation.kind !== 'refused') throw new Error('unreachable')
    expect(derivation.reason).toBe('description-model-not-configured')
  })

  it('判不出时把判定自己的理由带出来，不当成「没什么可派的」', () => {
    const derivation = derived(undefined, ['R2'])

    expect(derivation.kind).toBe('refused')
    if (derivation.kind !== 'refused') throw new Error('unreachable')
    expect(derivation.reason).toBe('undetermined')
    expect(derivation.detail).toBe('insufficient-signals')
  })

  it('派生的那一行既说得出结果，也说得出缺什么', () => {
    const numbers = derived('Dose–response curves; error bars show SEM; n = 6.', ['0.83'])
    expect(describeFigureDerivation(numbers)).toContain('1 number(s) from pdf-text-in-bbox')

    const refused = derived('Scheme 2', [])
    expect(describeFigureDerivation(refused)).toContain('refused: recognizer-unavailable')
  })
})

describe('applyAccessionLookups — 库号换成真取的记录，或具名说为什么没有', () => {
  const refused = {
    kind: 'refused' as const,
    reason: 'accession-lookup-not-wired' as const,
    requires: 'a lookup by accession against a real structure database',
    accessions: [{ kind: 'pdb' as const, id: '1CRN', where: 'in-figure-text' as const }]
  }

  it('upgrades to records — and keeps the basis (experimental vs predicted) visible', () => {
    const upgraded = applyAccessionLookups(refused, [
      {
        state: 'resolved',
        records: [
          {
            id: '1crn',
            basis: 'experimental',
            source: 'pdbe',
            title: 'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION'
          }
        ]
      }
    ])
    expect(upgraded.kind).toBe('records')
    if (upgraded.kind !== 'records') return
    expect(upgraded.records[0].id).toBe('1crn')
    expect(upgraded.records[0].basis).toBe('experimental')
  })

  it('names an unreachable service as unavailable and carries the next step', () => {
    const outcome = applyAccessionLookups(refused, [
      { state: 'unavailable', id: '1CRN', reason: 'no answer within 20000ms' }
    ])
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('accession-lookup-unavailable')
    expect(outcome.requires).toContain('no answer within 20000ms')
    expect(outcome.requires).toContain('proxy')
  })

  it('separates "the service has no such entry" from "nothing was looked up"', () => {
    const outcome = applyAccessionLookups(refused, [{ state: 'not-found', id: '1CRN' }])
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('accession-lookup-not-found')
    expect(outcome.requires).toContain('Nothing was invented')
  })

  it('leaves every other derivation exactly as it was', () => {
    const numbers = { kind: 'numbers' as const, source: 'pdf-text-in-bbox' as const, values: [] }
    expect(applyAccessionLookups(numbers, [{ state: 'not-found', id: 'X' }])).toEqual(numbers)
    const undetermined = {
      kind: 'refused' as const,
      reason: 'undetermined' as const,
      detail: 'no-signals' as const
    }
    expect(applyAccessionLookups(undetermined, [{ state: 'not-found', id: 'X' }])).toEqual(
      undetermined
    )
  })

  it('describes a records derivation by entry and basis', () => {
    expect(
      describeFigureDerivation({
        kind: 'records',
        source: 'accession-lookup',
        records: [{ id: 'AF-P00533-F1', basis: 'predicted', source: 'alphafold-db' }]
      })
    ).toBe('1 record(s) from accession-lookup: AF-P00533-F1 (predicted)')
  })
})
