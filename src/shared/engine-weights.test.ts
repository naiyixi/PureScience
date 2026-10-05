import { describe, expect, it } from 'vitest'

import { findEngine } from './engine-catalog'
import {
  ENGINE_WEIGHT_SPECS,
  describeEngineWeightGate,
  renderEngineWeightGateEnglish,
  weightDownloadPossible,
  weightGateBlocksEngine,
  type EngineWeightSpec
} from './engine-weights'

const published = (modelId: string, sha256: string, bytes = 1_000): EngineWeightSpec => ({
  modelId,
  url: `https://example.invalid/${modelId}/weights.bin`,
  bytes,
  sha256,
  license: 'MIT'
})

const hex64 = (seed: string): string => seed.repeat(64).slice(0, 64)

describe('engine weight gate', () => {
  it('reports engines that need no weights as needing nothing', () => {
    const pdb = findEngine('pdb')!
    expect(describeEngineWeightGate(pdb, { consent: true })).toEqual({
      state: 'not-needed',
      engineId: 'pdb'
    })
  })

  it('refuses to plan a download while no publisher checksum is on file', () => {
    const predictor = findEngine('ddg-cpu-predictor')!
    const gate = describeEngineWeightGate(predictor, { consent: true })
    // Consent is not the blocker here — there is nothing to download against a published checksum, so
    // approving a download could not change this. That is the distinction the old wording lost.
    expect(gate).toEqual({
      state: 'unpublished',
      engineId: 'ddg-cpu-predictor',
      reason: 'no-spec',
      weightBytes: 200_000_000
    })
    expect(weightGateBlocksEngine(gate)).toBe(true)
    expect(renderEngineWeightGateEnglish(gate)).toContain('no publisher checksum')
    expect(renderEngineWeightGateEnglish(gate)).toContain('do not offer a download')
  })

  it('treats a recorded checksum that is not a published SHA256 as still-unresolved', () => {
    const esmfold = findEngine('esmfold')!
    const gate = describeEngineWeightGate(esmfold, {
      consent: true,
      specs: [published('esmfold', 'not-a-checksum')]
    })
    expect(gate.state).toBe('unpublished')
    expect(gate).toMatchObject({ reason: 'invalid-checksum', weightBytes: 1_000 })
    expect(weightGateBlocksEngine(gate)).toBe(true)
  })

  it('asks for approval only once a published checksum exists, and is ready only after approval', () => {
    const esmfold = findEngine('esmfold')!
    const specs = [published('esmfold', hex64('a'))]
    expect(describeEngineWeightGate(esmfold, { specs })).toMatchObject({
      state: 'awaiting-consent',
      spec: { modelId: 'esmfold' }
    })
    const approved = describeEngineWeightGate(esmfold, { consent: true, specs })
    expect(approved.state).toBe('ready')
    expect(weightGateBlocksEngine(approved)).toBe(false)
    expect(renderEngineWeightGateEnglish(approved)).toContain('approved this download')
  })

  it('states plainly that this build cannot download weights at all', () => {
    // Populating this list is a release decision (publisher, hosting, checksum), never a code change
    // that can be made silently — so the empty state is asserted rather than assumed.
    expect(ENGINE_WEIGHT_SPECS).toHaveLength(0)
    expect(weightDownloadPossible()).toBe(false)
    expect(weightDownloadPossible([published('esmfold', hex64('b'))])).toBe(true)
    expect(weightDownloadPossible([published('esmfold', 'nope')])).toBe(false)
  })
})
