import { describe, expect, it } from 'vitest'

import type { EngineAvailabilityContext } from './engine-catalog'
import {
  planDdgRoute,
  planFoldingRoute,
  planStructureRoute,
  routeProvenanceIsHonest
} from './engine-routing'

const laptop: EngineAvailabilityContext = {
  hasGpu: false,
  allowOnDemandDownload: false,
  hasComputeHost: false
}
const workstation: EngineAvailabilityContext = {
  hasGpu: true,
  allowOnDemandDownload: true,
  hasComputeHost: false
}
const cluster: EngineAvailabilityContext = {
  hasGpu: false,
  allowOnDemandDownload: true,
  hasComputeHost: true
}

describe('structure routing', () => {
  it('treats a PDB entry as a measurement and an AlphaFold entry as a database prediction', () => {
    const pdb = planStructureRoute({ kind: 'pdb', id: '6YQK' }, laptop)
    expect(pdb.kind).toBe('database-lookup')
    expect(pdb.requiresApproval).toBe(false)
    expect(pdb.provenance.join(' ')).toContain('实验测量')

    const afdb = planStructureRoute({ kind: 'uniprot', id: 'Q9UPX8' }, laptop)
    expect(afdb.kind).toBe('database-lookup')
    expect(afdb.message).toContain('数据库预测')
    expect(afdb.message).toContain('不是实验结构')
  })

  it('routes de novo folding to a remote job behind approval when only a cluster is available', () => {
    const route = planFoldingRoute(cluster)
    expect(route.kind).toBe('remote-job')
    expect(route.requiresApproval).toBe(true)
    expect(routeProvenanceIsHonest(route)).toBe(true)
  })

  it('asks for consent before downloading local weights, and never assumes it', () => {
    const noConsent = planFoldingRoute({
      hasGpu: true,
      allowOnDemandDownload: false,
      hasComputeHost: false
    })
    expect(noConsent.kind).toBe('needs-consent')

    const consented = planFoldingRoute(workstation)
    expect(consented.kind).toBe('local-job')
  })

  it('says "not computed" with the reason when nothing can fold', () => {
    const route = planFoldingRoute(laptop)
    expect(route.kind).toBe('not-computed')
    expect(route.message).toContain('未计算')
    expect(route.message).toContain('需要 GPU')
    expect(route.provenance).toEqual([])
  })
})

describe('ddg routing', () => {
  it('sends physics-based ΔΔG to a remote host with approval required', () => {
    const route = planDdgRoute(cluster)
    expect(route.kind).toBe('remote-job')
    expect(route.requiresApproval).toBe(true)
    expect(routeProvenanceIsHonest(route)).toBe(true)
  })

  it('falls back to a consented CPU prediction only after consent, labelled as a prediction', () => {
    const noConsent = planDdgRoute(laptop)
    expect(noConsent.kind).toBe('needs-consent')

    const consented = planDdgRoute({
      hasGpu: false,
      allowOnDemandDownload: true,
      hasComputeHost: false
    })
    expect(consented.kind).toBe('local-job')
    expect(consented.provenance.join(' ')).toContain('预测')
    expect(routeProvenanceIsHonest(consented)).toBe(true)
    if (consented.kind !== 'not-computed') {
      expect(consented.message).toContain('预测值')
      expect(consented.message).not.toContain('已计算完成')
    }
  })

  it('never substitutes a qualitative description when no ΔΔG route exists', () => {
    const route = planDdgRoute(laptop)
    expect(route.kind).toBe('needs-consent')
    expect(route.message).toContain('不会静默下载')
  })

  it('keeps the honesty check meaningful for every route kind', () => {
    for (const route of [
      planStructureRoute({ kind: 'uniprot', id: 'Q9UPX8' }, laptop),
      planFoldingRoute(cluster),
      planDdgRoute(laptop),
      planDdgRoute(laptop)
    ]) {
      expect(routeProvenanceIsHonest(route)).toBe(true)
    }
  })
})
