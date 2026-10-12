import { describe, expect, it } from 'vitest'

import {
  describeStructureArtifactFacts,
  engineForPredictionPath,
  engineIdFromPredictionPath,
  structureArtifactFactsAreHonest,
  type StructureArtifactFact
} from './structure-artifact-facts'
import { ENGINE_CATALOG } from './engine-catalog'

const esmfold = ENGINE_CATALOG.find((engine) => engine.id === 'esmfold')!
const alphafoldDb = ENGINE_CATALOG.find((engine) => engine.id === 'alphafold-db')!
const pdb = ENGINE_CATALOG.find((engine) => engine.id === 'pdb')!
const ddgCpu = ENGINE_CATALOG.find((engine) => engine.id === 'ddg-cpu-predictor')!

describe('结构产物：引擎身份只从应用自己的路径约定里解析', () => {
  it('认 predictions/<engineId>/… 这一种形状（含 Windows 反斜杠）', () => {
    expect(engineIdFromPredictionPath('/data/workspaces/s1/predictions/esmfold/1abc.pdb')).toBe(
      'esmfold'
    )
    expect(engineIdFromPredictionPath('C:\\data\\predictions\\colabfold\\model_1.cif')).toBe(
      'colabfold'
    )
    expect(engineForPredictionPath('/x/predictions/alphafold-db/A0.pdb')?.id).toBe('alphafold-db')
  })

  it('解析不到就返回 undefined —— 不按文件名像不像去认引擎', () => {
    // 「文件名里有 esmfold 字样」不是身份：真身份只能来自应用自己的落点约定。
    expect(engineIdFromPredictionPath('/data/esmfold-model.pdb')).toBeUndefined()
    expect(engineIdFromPredictionPath('/data/predictions/esmfold-ish/x.pdb')).toBeUndefined()
    expect(engineIdFromPredictionPath('/data/predictions/')).toBeUndefined()
    expect(engineIdFromPredictionPath('/data/predictions')).toBeUndefined()
    expect(engineIdFromPredictionPath(undefined)).toBeUndefined()
    expect(engineForPredictionPath('/data/predictions/nope/x.pdb')).toBeUndefined()
  })

  it('目录里认识的引擎才给事实（不认识 = 什么都不显示，不是「未知引擎」）', () => {
    for (const engine of ENGINE_CATALOG) {
      expect(engineForPredictionPath(`/p/predictions/${engine.id}/x.pdb`)?.id).toBe(engine.id)
    }
    expect(engineForPredictionPath('/p/predictions/made-up-engine/x.pdb')).toBeUndefined()
  })
})

describe('结构产物：事实行（引擎 / 输出性质 / 许可 / 权重）', () => {
  it('预测引擎的输出行标记 mustBeLabelled', () => {
    const facts = describeStructureArtifactFacts(esmfold)
    expect(facts.find((fact) => fact.kind === 'engine')).toMatchObject({
      engineId: 'esmfold',
      engineLabel: esmfold.label
    })
    expect(facts.find((fact) => fact.kind === 'output')).toEqual({
      kind: 'output',
      outputKind: 'predicted',
      mustBeLabelled: true
    })
  })

  it('数据库查询与实验结构都不是 predicted（不许混为一谈）', () => {
    const lookup = describeStructureArtifactFacts(alphafoldDb).find(
      (fact) => fact.kind === 'output'
    )
    expect(lookup).toEqual({ kind: 'output', outputKind: 'lookup', mustBeLabelled: false })

    const measured = describeStructureArtifactFacts(pdb).find((fact) => fact.kind === 'output')
    expect(measured).toEqual({ kind: 'output', outputKind: 'measured', mustBeLabelled: false })
  })

  it('许可事实随产物走：商用受限就写在视图会显示的那一行上', () => {
    const facts = describeStructureArtifactFacts(ddgCpu)
    const license = facts.find((fact) => fact.kind === 'license')
    expect(license).toMatchObject({
      kind: 'license',
      licenseId: 'academic-use',
      commercialRestricted: true
    })
    // 每条事实行都来自目录（单一来源），不在这里另写判断。
    expect(facts.find((fact) => fact.kind === 'weights')).toMatchObject({ kind: 'weights' })
  })

  it('收尾门：没有「输出性质」这一行的事实不许上屏', () => {
    const facts = describeStructureArtifactFacts(esmfold)
    expect(structureArtifactFactsAreHonest(facts)).toBe(true)

    const withoutOutput = facts.filter(
      (fact): fact is StructureArtifactFact => fact.kind !== 'output'
    )
    expect(structureArtifactFactsAreHonest(withoutOutput)).toBe(false)
    expect(structureArtifactFactsAreHonest([])).toBe(false)
  })
})
