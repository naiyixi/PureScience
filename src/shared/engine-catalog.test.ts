import { describe, expect, it } from 'vitest'

import {
  ENGINE_CATALOG,
  ENGINE_CATALOG_SCHEMA_VERSION,
  describeEngineAvailabilityEnglish,
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
    // Provenance carries the id, not the display label: the label belongs to whichever surface is
    // speaking (the window says it through `labelKey`), so a number can be audited without it.
    expect(describeEngineProvenance(findEngine('esmfold')!)).toContain('esmfold')
    expect(describeEngineProvenance(findEngine('esmfold')!)).not.toContain('ESMFold (local')
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

  it('formats weight sizes without committing to a language', () => {
    // Locale-neutral on purpose: each surface interpolates the number into a sentence of its own
    // language (the window through a dictionary key, the agent surfaces in English).
    expect(formatWeightSize(0)).toBe('none')
    expect(formatWeightSize(15_000_000_000)).toBe('15 GB')
    expect(formatWeightSize(200_000_000)).toBe('200 MB')
  })

  it('gives the agent an English verdict for every state, with no localised text in it', () => {
    const cjk = /[\u3400-\u4dbf\u4e00-\u9fff]/
    const verdicts = [
      evaluateEngineAvailability(findEngine('pdb')!, laptop),
      evaluateEngineAvailability(findEngine('ddg-cpu-predictor')!, laptop),
      evaluateEngineAvailability(findEngine('openmm-fep')!, laptop),
      evaluateEngineAvailability(findEngine('esmfold')!, laptop)
    ]
    expect(verdicts.map((verdict) => verdict.status)).toEqual([
      'ready',
      'needs-consent',
      'needs-host',
      'unavailable'
    ])
    for (const verdict of verdicts) {
      const english = describeEngineAvailabilityEnglish(verdict)
      expect(english.length).toBeGreaterThan(5)
      expect(english).not.toMatch(cjk)
    }
    // The two refusal states must name what is missing rather than going vague.
    expect(describeEngineAvailabilityEnglish(verdicts[1])).toContain("the user's approval")
    expect(describeEngineAvailabilityEnglish(verdicts[1])).toContain('200 MB')
    expect(describeEngineAvailabilityEnglish(verdicts[2])).toContain('compute host')
    expect(describeEngineAvailabilityEnglish(verdicts[3])).toContain('GPU')
  })

  it('keeps the shared display copy English and the window copy keyed', () => {
    // The shared catalog is read by the agent-facing surfaces, which are never localised; the window
    // renders labelKey/summaryKey through the dictionaries. A CJK literal in label/summary would
    // either leak into the English agent doc or become untranslatable UI copy — both are regressions.
    const cjk = /[\u3400-\u4dbf\u4e00-\u9fff]/
    for (const engine of ENGINE_CATALOG) {
      expect(engine.label).not.toMatch(cjk)
      expect(engine.summary).not.toMatch(cjk)
      expect(engine.labelKey).toBe(`engines.${engine.id}.label`)
      expect(engine.summaryKey).toBe(`engines.${engine.id}.summary`)
    }
  })
})
