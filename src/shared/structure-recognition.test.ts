import { describe, expect, it } from 'vitest'

import {
  agreeOnStructure,
  describeStructureRecognition,
  structureRecognitionFingerprint,
  structureRecognitionRecipe,
  type StructureRecognitionReading
} from './structure-recognition'

const read = (
  engine: StructureRecognitionReading['engine'],
  canonical: string,
  revision = 'v1'
): StructureRecognitionReading => ({
  engine,
  state: 'read',
  revision,
  smiles: canonical,
  canonical
})

describe('agreeOnStructure — 几台引擎一致才算数', () => {
  it('accepts a reading only when two independent engines agree', () => {
    const outcome = agreeOnStructure([read('decimer', 'CCO'), read('molscribe', 'CCO')])
    expect(outcome.state).toBe('agreed')
    if (outcome.state !== 'agreed') return
    expect(outcome.canonical).toBe('CCO')
    expect(outcome.engines.map((engine) => engine.engine)).toEqual(['decimer', 'molscribe'])
  })

  it('names a single engine as the reason, not the image quality', () => {
    const outcome = agreeOnStructure([
      read('decimer', 'CCO'),
      { engine: 'molscribe', state: 'unavailable', detail: 'no interpreter' }
    ])
    expect(outcome.state).toBe('refused')
    if (outcome.state !== 'refused') return
    expect(outcome.reason).toBe('recognizer-single-engine')
    // 各自说了什么都要在结果里，读者能自己看
    expect(outcome.readings).toHaveLength(2)
  })

  it('refuses a disagreement instead of picking a favourite', () => {
    const outcome = agreeOnStructure([read('decimer', 'CCO'), read('molscribe', 'CCC')])
    expect(outcome.state).toBe('refused')
    if (outcome.state !== 'refused') return
    expect(outcome.reason).toBe('recognizer-disagreement')
  })

  it('refuses by name when no engine produced a readable structure', () => {
    const outcome = agreeOnStructure([
      { engine: 'decimer', state: 'unavailable', detail: 'absent' },
      { engine: 'molscribe', state: 'failed', reason: 'recognition-failed', detail: 'boom' }
    ])
    expect(outcome.state).toBe('refused')
    if (outcome.state !== 'refused') return
    expect(outcome.reason).toBe('recognizer-unavailable')
  })

  it('needs a strict majority: two agreeing out of three agrees, a 1-1 read does not', () => {
    const majority = agreeOnStructure([
      read('decimer', 'CCO'),
      read('molscribe', 'CCO'),
      { engine: 'molscribe', state: 'failed', reason: 'x', detail: 'y' }
    ])
    expect(majority.state).toBe('agreed')

    const tie = agreeOnStructure([read('decimer', 'CCO'), read('molscribe', 'CCC')])
    expect(tie.state).toBe('refused')
  })

  it('counts only readings that carry a canonical structure', () => {
    const outcome = agreeOnStructure([
      { engine: 'decimer', state: 'read', revision: 'v1', smiles: 'CCO', canonical: '   ' },
      read('molscribe', 'CCO')
    ])
    expect(outcome.state).toBe('refused')
    if (outcome.state !== 'refused') return
    expect(outcome.reason).toBe('recognizer-single-engine')
  })
})

describe('structureRecognitionFingerprint — 算输入，且可在应用之外复算', () => {
  const base = {
    page: 3,
    bbox: { x: 10, y: 20, width: 300, height: 200 },
    dpi: 200,
    engines: [{ engine: 'decimer' as const, revision: 'DECIMER 2.8.0' }]
  }

  it('is stable, shaped like the other provenance fingerprints, and carries no timestamp', () => {
    const first = structureRecognitionFingerprint(base)
    expect(first).toBe(structureRecognitionFingerprint({ ...base }))
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(structureRecognitionRecipe(base)).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(structureRecognitionRecipe(base)).toContain('purescience/structure-recognition/v1')
  })

  it('changes with the page, the box, the DPI or the engine revision', () => {
    const first = structureRecognitionFingerprint(base)
    expect(structureRecognitionFingerprint({ ...base, page: 4 })).not.toBe(first)
    expect(
      structureRecognitionFingerprint({ ...base, bbox: { ...base.bbox, width: 301 } })
    ).not.toBe(first)
    expect(structureRecognitionFingerprint({ ...base, dpi: 300 })).not.toBe(first)
    expect(
      structureRecognitionFingerprint({
        ...base,
        engines: [{ engine: 'decimer', revision: 'DECIMER 2.9.0' }]
      })
    ).not.toBe(first)
  })

  it('does not depend on the order the engines are listed in', () => {
    const left = structureRecognitionFingerprint({
      ...base,
      engines: [
        { engine: 'decimer', revision: 'a' },
        { engine: 'molscribe', revision: 'b' }
      ]
    })
    const right = structureRecognitionFingerprint({
      ...base,
      engines: [
        { engine: 'molscribe', revision: 'b' },
        { engine: 'decimer', revision: 'a' }
      ]
    })
    expect(left).toBe(right)
  })
})

describe('describeStructureRecognition', () => {
  it('names both engines on agreement and every reading on refusal', () => {
    const agreed = agreeOnStructure([
      read('decimer', 'CCO', 'DECIMER 2.8.0'),
      read('molscribe', 'CCO', 'MolScribe 1.1.1')
    ])
    expect(describeStructureRecognition(agreed)).toBe(
      'agreed on CCO by decimer DECIMER 2.8.0 + molscribe MolScribe 1.1.1'
    )

    const refused = agreeOnStructure([read('decimer', 'CCO'), read('molscribe', 'CCC')])
    expect(describeStructureRecognition(refused)).toContain('refused: recognizer-disagreement')
    expect(describeStructureRecognition(refused)).toContain('molscribe: CCC')
  })
})
