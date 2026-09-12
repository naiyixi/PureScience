import { describe, expect, it } from 'vitest'

import { describeEsmDownloadConsent, estimateEsmDdg, ESM_DDG_MODELS } from './ddg-esm'

const calibrate = {
  factorKcalPerMolPerLogRatio: 1.5,
  source: 'ours: fit on S2648 subset (pending)'
}

describe('zero-shot ESM ΔΔG contract', () => {
  it('refuses to produce an energy without a declared calibration', () => {
    const estimate = estimateEsmDdg([{ modelId: 'esm2-650m', logRatio: -2.4 }])
    expect(estimate.status).toBe('uncalibrated')
    if (estimate.status !== 'uncalibrated') return
    expect(estimate.meanLogRatio).toBe(-2.4)
    expect(estimate.message).toContain('不给出 kcal/mol')
    expect(JSON.stringify(estimate)).not.toContain('deltaGkcalPerMol')
  })

  it('reports a calibrated estimate with dispersion and the fixed sign convention', () => {
    const estimate = estimateEsmDdg(
      [
        { modelId: 'esm2-150m', logRatio: -2.0 },
        { modelId: 'esm2-650m', logRatio: -2.4 }
      ],
      { calibration: calibrate, retrievedAt: '2026-09-12T00:00:00.000Z' }
    )
    expect(estimate.status).toBe('ok')
    if (estimate.status !== 'ok') return
    expect(estimate.deltaGkcalPerMol).toBe(-3.3)
    expect(estimate.dispersionKcalPerMol).toBe(0.6)
    expect(estimate.confidence).toBe('moderate')
    expect(estimate.provenance.join('\n')).toContain('负值表示去稳定')
    expect(estimate.provenance.join('\n')).toContain('MIT')
    expect(estimate.provenance.join('\n')).toContain('校准：1.5 kcal/mol per log-ratio')
    expect(estimate.warnings.join(' ')).toContain('预测值')
  })

  it('drops to low confidence for a single model and says why', () => {
    const estimate = estimateEsmDdg([{ modelId: 'esm2-150m', logRatio: -1.0 }], {
      calibration: calibrate
    })
    expect(estimate.status).toBe('ok')
    if (estimate.status !== 'ok') return
    expect(estimate.confidence).toBe('low')
    expect(estimate.dispersionKcalPerMol).toBe(0)
    expect(estimate.warnings.join(' ')).toContain('单模型')
  })

  it('flags large model disagreement instead of averaging it away', () => {
    const estimate = estimateEsmDdg(
      [
        { modelId: 'esm2-150m', logRatio: -0.5 },
        { modelId: 'esm2-650m', logRatio: 2.5 }
      ],
      { calibration: calibrate }
    )
    expect(estimate.status).toBe('ok')
    if (estimate.status !== 'ok') return
    expect(estimate.confidence).toBe('low')
    expect(estimate.warnings.join(' ')).toContain('分歧较大')
  })

  it('returns "not computed" for no scores or an unknown model', () => {
    const empty = estimateEsmDdg([])
    expect(empty.status).toBe('insufficient')
    if (empty.status !== 'insufficient') return
    expect(empty.message).toContain('未计算 ΔΔG')

    const unknown = estimateEsmDdg([{ modelId: 'alphafold2-local', logRatio: -1 }])
    expect(unknown.status).toBe('insufficient')
    if (unknown.status !== 'insufficient') return
    expect(unknown.message).toContain('未知模型')
  })

  it('rejects a non-positive or non-finite calibration factor', () => {
    const bad = estimateEsmDdg([{ modelId: 'esm2-150m', logRatio: -1 }], {
      calibration: { factorKcalPerMolPerLogRatio: 0, source: 'nonsense' }
    })
    expect(bad.status).toBe('insufficient')
  })

  it('describes the on-demand download honestly (size, licence, checksum)', () => {
    const consent = describeEsmDownloadConsent('esm2-650m')
    expect(consent.ok).toBe(true)
    if (!consent.ok) return
    expect(consent.lines.join('\n')).toContain('按需下载')
    expect(consent.lines.join('\n')).toContain('MIT')
    expect(consent.lines.join('\n')).toContain('SHA256')
    expect(consent.lines.join('\n')).toContain('未计算')

    const unknown = describeEsmDownloadConsent('nonexistent')
    expect(unknown.ok).toBe(false)

    expect(
      ESM_DDG_MODELS.every((model) => model.license === 'MIT' && model.requiresDownloadConsent)
    ).toBe(true)
  })
})
