import { describe, expect, it, vi } from 'vitest'

import { lookupAlphaFoldModel, type AlphaFoldModelRecord } from './alphafold-lookup'

const model: AlphaFoldModelRecord = {
  entryId: 'AF-Q9UPX8-F1',
  providerId: 'GDM',
  toolUsed: 'AlphaFold Monomer v2.0',
  globalMetricValue: 82.4,
  pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-Q9UPX8-F1-model_v4.pdb',
  cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-Q9UPX8-F1-model_v4.cif',
  uniprotAccession: 'Q9UPX8'
}

describe('AlphaFold DB lookup', () => {
  it('returns the model labelled as a database prediction with full provenance', async () => {
    const fetchPrediction = vi.fn(async () => [model])
    const outcome = await lookupAlphaFoldModel('q9upx8', fetchPrediction, {
      retrievedAt: '2026-09-12T00:00:00.000Z'
    })

    expect(fetchPrediction).toHaveBeenCalledWith('Q9UPX8')
    expect(outcome.status).toBe('found')
    if (outcome.status !== 'found') return
    expect(outcome.model.entryId).toBe('AF-Q9UPX8-F1')
    expect(outcome.model.plddtMean).toBe(82.4)
    expect(outcome.provenance.join('\n')).toContain('数据库查询')
    expect(outcome.provenance.join('\n')).toContain('非实验结构')
    expect(outcome.provenance.join('\n')).toContain('检索时间：2026-09-12T00:00:00.000Z')
    expect(outcome.message).toContain('数据库预测')
  })

  it('treats an empty payload as "no entry" and points at the folding route', async () => {
    const outcome = await lookupAlphaFoldModel('P00000', async () => [])
    expect(outcome.status).toBe('not-found')
    if (outcome.status !== 'not-found') return
    expect(outcome.nextRoute).toBe('folding')
    expect(outcome.message).toContain('折叠引擎')
    expect(outcome.message).not.toContain('猜测结构已生成')
  })

  it('surfaces transport failures without falling back to a qualitative description', async () => {
    const outcome = await lookupAlphaFoldModel('Q9UPX8', async () => {
      throw new Error('network down')
    })
    expect(outcome.status).toBe('error')
    if (outcome.status !== 'error') return
    expect(outcome.message).toContain('查询失败')
    expect(outcome.message).toContain('network down')
    expect(outcome.message).toContain('不要退回定性描述')
  })

  it('rejects an empty identifier instead of querying', async () => {
    const fetchPrediction = vi.fn()
    const outcome = await lookupAlphaFoldModel('   ', fetchPrediction)
    expect(outcome.status).toBe('error')
    expect(fetchPrediction).not.toHaveBeenCalled()
  })

  it('ignores records that carry no usable entry or file', async () => {
    const outcome = await lookupAlphaFoldModel('Q9UPX8', async () => [{ providerId: 'GDM' }, model])
    expect(outcome.status).toBe('found')
    if (outcome.status !== 'found') return
    expect(outcome.model.entryId).toBe('AF-Q9UPX8-F1')
  })
})
