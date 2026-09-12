import { describe, expect, it } from 'vitest'

import {
  ENGINE_CATALOG,
  ENGINE_CATALOG_SCHEMA_VERSION,
  describeEngineProvenance,
  evaluateEngineAvailability,
  findEngine,
  formatWeightSize,
  isPredictedOutput,
  resolveEnginesForTask,
  type EngineAvailabilityContext
} from './engine-catalog'

const laptop: EngineAvailabilityContext = {
  hasGpu: false,
  allowOnDemandDownload: false,
  hasComputeHost: false
}

describe('engine catalog', () => {
  it('declares unique ids and a schema version', () => {
    expect(ENGINE_CATALOG_SCHEMA_VERSION).toBe(1)
    const ids = ENGINE_CATALOG.map((engine) => engine.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const engine of ENGINE_CATALOG) {
      expect(engine.summary.length).toBeGreaterThan(8)
      expect(engine.label.length).toBeGreaterThan(2)
    }
  })

  it('keeps predictions distinguishable from measurements', () => {
    expect(isPredictedOutput(findEngine('esmfold')!)).toBe(true)
    expect(isPredictedOutput(findEngine('ddg-cpu-predictor')!)).toBe(true)
    expect(isPredictedOutput(findEngine('pdb')!)).toBe(false)
    expect(describeEngineProvenance(findEngine('pdb')!)).toContain('实验测量')
    expect(describeEngineProvenance(findEngine('esmfold')!)).toContain('预测')
    expect(describeEngineProvenance(findEngine('esmfold')!)).toContain('非实验值')
    expect(describeEngineProvenance(findEngine('alphafold-db')!)).toContain('数据库查询')
  })

  it('states honestly that a GPU engine cannot run on a host without a GPU and without a remote', () => {
    const availability = evaluateEngineAvailability(findEngine('esmfold')!, laptop)
    expect(availability.status).toBe('unavailable')
    expect(availability.status === 'unavailable' ? availability.reason : '').toContain('需要 GPU')
  })

  it('requires a registered host for remote-only engines', () => {
    const availability = evaluateEngineAvailability(findEngine('openmm-fep')!, {
      hasGpu: true,
      allowOnDemandDownload: true,
      hasComputeHost: false
    })
    expect(availability.status).toBe('needs-host')
    expect(availability.status === 'needs-host' ? availability.reason : '').toContain('计算主机')
  })

  it('requires explicit consent before an on-demand download, and never assumes it', () => {
    const needsConsent = evaluateEngineAvailability(findEngine('ddg-cpu-predictor')!, laptop)
    expect(needsConsent.status).toBe('needs-consent')
    expect(needsConsent.status === 'needs-consent' ? needsConsent.reason : '').toContain(
      '不会静默下载'
    )

    const ready = evaluateEngineAvailability(findEngine('ddg-cpu-predictor')!, {
      ...laptop,
      allowOnDemandDownload: true
    })
    expect(ready.status).toBe('ready')
  })

  it('lets zero-weight engines run without consent', () => {
    expect(evaluateEngineAvailability(findEngine('alphafold-db')!, laptop).status).toBe('ready')
    expect(evaluateEngineAvailability(findEngine('pdb')!, laptop).status).toBe('ready')
  })

  it('routes a GPU engine to a remote host when the local machine has none', () => {
    const availability = evaluateEngineAvailability(findEngine('esmfold')!, {
      hasGpu: false,
      allowOnDemandDownload: true,
      hasComputeHost: true
    })
    expect(availability.status).toBe('ready')
  })

  it('lists ready engines for a task and explains why the rest are out', () => {
    const ddg = resolveEnginesForTask('ddg-physics', {
      hasGpu: true,
      allowOnDemandDownload: true,
      hasComputeHost: true
    })
    expect(ddg.ready.map((engine) => engine.id).sort()).toEqual(['openmm-fep', 'rosetta-ddg'])

    const localDdg = resolveEnginesForTask('ddg-prediction', laptop)
    expect(localDdg.ready).toEqual([])
    expect(localDdg.blocked[0].reason).toContain('按需下载')

    const structures = resolveEnginesForTask('database-lookup', laptop)
    expect(structures.ready.map((engine) => engine.id).sort()).toEqual(['alphafold-db', 'pdb'])
  })

  it('formats weight sizes readably', () => {
    expect(formatWeightSize(0)).toBe('无需权重')
    expect(formatWeightSize(15_000_000_000)).toBe('约 15 GB')
    expect(formatWeightSize(200_000_000)).toBe('约 200 MB')
  })
})
