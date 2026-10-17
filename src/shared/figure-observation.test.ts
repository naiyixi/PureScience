import { describe, expect, it } from 'vitest'

import {
  FIGURE_DERIVATION_FINGERPRINT_PATTERN,
  FIGURE_DERIVATION_FINGERPRINT_RECIPE,
  figureDerivationModelRevision,
  figureDerivationRecipe,
  figureDerivationStatuses,
  isFigureDerivationObservation
} from './figure-observation'

const input = {
  page: 2,
  bbox: { x: 100, y: 300, width: 300, height: 200 },
  caption: 'Figure 9. Dose-response curves; error bars show SEM; n = 6.',
  inFigureText: ['0.83', 'p<0.001']
}

describe('figureDerivationRecipe / 指纹形状', () => {
  it('规范串逐字节可复算：同样的输入得到同一段文本，且首行是配方名', () => {
    const a = figureDerivationRecipe(input)
    const b = figureDerivationRecipe({ ...input, inFigureText: [...input.inFigureText] })

    expect(a).toBe(b)
    expect(a.split('\n')[0]).toBe(FIGURE_DERIVATION_FINGERPRINT_RECIPE)
    // 没有时间戳、没有计数器：同一份输入在别处也是这一段。
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('输入换了任一样，规范串就变（换页 / 换框 / 换图注 / 换图内文字）', () => {
    const base = figureDerivationRecipe(input)
    expect(figureDerivationRecipe({ ...input, page: 3 })).not.toBe(base)
    expect(figureDerivationRecipe({ ...input, bbox: { ...input.bbox, x: 101 } })).not.toBe(base)
    expect(figureDerivationRecipe({ ...input, caption: 'Scheme 1' })).not.toBe(base)
    expect(figureDerivationRecipe({ ...input, inFigureText: ['0.84', 'p<0.001'] })).not.toBe(base)
    // 顺序也是输入的一部分。
    expect(figureDerivationRecipe({ ...input, inFigureText: ['p<0.001', '0.83'] })).not.toBe(base)
  })

  it('浮点按定点写法，避开平台格式化差异', () => {
    const recipe = figureDerivationRecipe({
      ...input,
      bbox: { x: 100.0004, y: 300, width: 300, height: 200 }
    })
    expect(recipe).toContain('bbox=100.000,300.000,300.000,200.000')
  })
})

describe('isFigureDerivationObservation 形状守卫', () => {
  const valid = {
    page: 2,
    index: 1,
    bbox: { x: 100, y: 300, width: 300, height: 200 },
    figureClass: 'chart',
    inputFingerprint: `sha256:${'a'.repeat(64)}`,
    derivation: { kind: 'refused', reason: 'no-numbers-in-box' }
  }

  it('接住一条完整记录', () => {
    expect(isFigureDerivationObservation(valid)).toBe(true)
  })

  it('缺字段 / 指纹形状不对 / 派生结果不是对象，一律不算一条', () => {
    expect(isFigureDerivationObservation(undefined)).toBe(false)
    expect(isFigureDerivationObservation({ ...valid, inputFingerprint: 'not-a-digest' })).toBe(
      false
    )
    expect(isFigureDerivationObservation({ ...valid, page: 'two' })).toBe(false)
    expect(isFigureDerivationObservation({ ...valid, derivation: 'refused' })).toBe(false)
    const { bbox: _bbox, ...withoutBox } = valid
    expect(isFigureDerivationObservation(withoutBox)).toBe(false)
  })

  it('指纹形状常量与守卫一致', () => {
    expect(FIGURE_DERIVATION_FINGERPRINT_PATTERN.test(`sha256:${'b'.repeat(64)}`)).toBe(true)
    expect(FIGURE_DERIVATION_FINGERPRINT_PATTERN.test('sha256:XYZ')).toBe(false)
  })
})

describe('figureDerivationStatuses / 换输入或换模型版本 ⇒ 旧结果被标过期', () => {
  const derivation = (
    overrides: Partial<{
      page: number
      index: number
      fingerprint: string
      modelRevision: string | undefined
    }> = {}
  ): {
    page: number
    index: number
    bbox: { x: number; y: number; width: number; height: number }
    figureClass: 'chart'
    inputFingerprint: string
    modelRevision?: string
    derivation: { kind: 'refused'; reason: 'no-numbers-in-box' }
  } => ({
    page: overrides.page ?? 2,
    index: overrides.index ?? 1,
    bbox: { x: 100, y: 300, width: 300, height: 200 },
    figureClass: 'chart' as const,
    inputFingerprint: overrides.fingerprint ?? `sha256:${'a'.repeat(64)}`,
    ...(overrides.modelRevision ? { modelRevision: overrides.modelRevision } : {}),
    derivation: { kind: 'refused' as const, reason: 'no-numbers-in-box' as const }
  })

  it('只有一条派生 ⇒ current（判决写在值上，不是缺席）', () => {
    const statuses = figureDerivationStatuses([
      { recordedAt: '2026-10-18T01:00:00.000Z', figureDerivation: derivation() }
    ])
    expect(statuses).toEqual([{ state: 'current' }])
  })

  it('非派生行没有这份判决（undefined 只表示「这一行不是派生」）', () => {
    const statuses = figureDerivationStatuses([
      { recordedAt: '2026-10-18T01:00:00.000Z' },
      { recordedAt: '2026-10-18T01:01:00.000Z', figureDerivation: derivation() }
    ])
    expect(statuses[0]).toBeUndefined()
    expect(statuses[1]).toEqual({ state: 'current' })
  })

  it('同一张图后来换了输入 ⇒ 早的那条 input-changed，晚的那条 current', () => {
    const statuses = figureDerivationStatuses([
      { recordedAt: '2026-10-18T01:00:00.000Z', figureDerivation: derivation() },
      {
        recordedAt: '2026-10-18T01:05:00.000Z',
        figureDerivation: derivation({ fingerprint: `sha256:${'b'.repeat(64)}` })
      }
    ])
    expect(statuses[0]).toEqual({
      state: 'superseded',
      reason: 'input-changed',
      supersededAt: '2026-10-18T01:05:00.000Z',
      supersededBy: `sha256:${'b'.repeat(64)}`
    })
    expect(statuses[1]).toEqual({ state: 'current' })
  })

  it('输入相同、模型版本不同 ⇒ 早的那条 model-revision-changed', () => {
    const statuses = figureDerivationStatuses([
      {
        recordedAt: '2026-10-18T01:00:00.000Z',
        figureDerivation: derivation({ modelRevision: 'decimer@2.8.0+molscribe@1.1.1' })
      },
      {
        recordedAt: '2026-10-18T01:06:00.000Z',
        figureDerivation: derivation({ modelRevision: 'decimer@2.9.0+molscribe@1.1.1' })
      }
    ])
    expect(statuses[0]).toMatchObject({
      state: 'superseded',
      reason: 'model-revision-changed'
    })
    expect(statuses[1]).toEqual({ state: 'current' })
  })

  it('输入与版本都相同 ⇒ 两条都是 current（只是又算了一次，结论没变）', () => {
    const statuses = figureDerivationStatuses([
      { recordedAt: '2026-10-18T01:00:00.000Z', figureDerivation: derivation() },
      { recordedAt: '2026-10-18T01:07:00.000Z', figureDerivation: derivation() }
    ])
    expect(statuses).toEqual([{ state: 'current' }, { state: 'current' }])
  })

  it('判决只跟同一张图（同页同图序）的最新那条比：别的图不影响它', () => {
    const statuses = figureDerivationStatuses([
      { recordedAt: '2026-10-18T01:00:00.000Z', figureDerivation: derivation({ index: 1 }) },
      {
        recordedAt: '2026-10-18T01:08:00.000Z',
        figureDerivation: derivation({ index: 2, fingerprint: `sha256:${'c'.repeat(64)}` })
      }
    ])
    expect(statuses).toEqual([{ state: 'current' }, { state: 'current' }])
  })

  it('按日志顺序而不是时间戳判：同毫秒的两条也分得清谁在后面', () => {
    const statuses = figureDerivationStatuses([
      { recordedAt: '2026-10-18T01:00:00.000Z', figureDerivation: derivation() },
      {
        recordedAt: '2026-10-18T01:00:00.000Z',
        figureDerivation: derivation({ fingerprint: `sha256:${'d'.repeat(64)}` })
      }
    ])
    expect(statuses[0]).toMatchObject({ state: 'superseded', reason: 'input-changed' })
    expect(statuses[1]).toEqual({ state: 'current' })
  })
})

describe('figureDerivationModelRevision / 谁产出了这份结果', () => {
  it('化学一路：引擎@版本按引擎原样拼起来（两台各自可比）', () => {
    expect(
      figureDerivationModelRevision({
        kind: 'structure',
        source: 'ocsr',
        smiles: 'OCC',
        canonical: 'CCO',
        engines: [
          { engine: 'decimer', revision: '2.8.0' },
          { engine: 'molscribe', revision: '1.1.1' }
        ],
        recognitionFingerprint: `sha256:${'e'.repeat(64)}`
      })
    ).toBe('decimer@2.8.0+molscribe@1.1.1')
  })

  it('确定性的一路没有模型 ⇒ 缺席，不写一个看起来像版本号的假值', () => {
    expect(
      figureDerivationModelRevision({
        kind: 'numbers',
        source: 'pdf-text-in-bbox',
        values: []
      })
    ).toBeUndefined()
    expect(
      figureDerivationModelRevision({
        kind: 'refused',
        reason: 'recognizer-unavailable',
        requires: 'two independent OCSR engines'
      })
    ).toBeUndefined()
  })
})
