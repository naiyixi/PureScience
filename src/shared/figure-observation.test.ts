import { describe, expect, it } from 'vitest'

import {
  FIGURE_DERIVATION_FINGERPRINT_PATTERN,
  FIGURE_DERIVATION_FINGERPRINT_RECIPE,
  figureDerivationRecipe,
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
