import { describe, expect, it } from 'vitest'

import { isHostDenied } from './egress'
import { engineForPredictionPath } from './structure-artifact-facts'
import {
  STRUCTURE_REMOTE_HOST,
  STRUCTURE_REMOTE_MAX_BYTES,
  STRUCTURE_REMOTE_SOURCES,
  decideStructureRemoteLoad,
  normalizeStructureRemotePdbId,
  normalizeStructureRemoteUniProtId,
  structureRemoteAlphaFoldFileName,
  structureRemoteAlphaFoldUrl,
  structureRemoteFileName,
  structureRemoteRelativeDirectory,
  structureRemoteSource,
  structureRemoteUrl
} from './structure-remote-source'

describe('远程结构加载：id 与固定模板', () => {
  it('接受 4 位 PDB id（大小写都行），并规范成大写', () => {
    expect(normalizeStructureRemotePdbId('1crn')).toBe('1CRN')
    expect(normalizeStructureRemotePdbId(' 7VH8 ')).toBe('7VH8')
    expect(normalizeStructureRemotePdbId('4HHB')).toBe('4HHB')
  })

  it('形状不对就拒绝，**不截断**成一个看起来像 id 的东西', () => {
    // 截断会把一个错的 id 变成一个「看起来对」的别的结构 —— 那比直接拒绝更糟。
    expect(normalizeStructureRemotePdbId('1cr')).toBeUndefined()
    expect(normalizeStructureRemotePdbId('1crnxx')).toBeUndefined()
    expect(normalizeStructureRemotePdbId('ACRN')).toBeUndefined()
    expect(normalizeStructureRemotePdbId('1-CN')).toBeUndefined()
    expect(normalizeStructureRemotePdbId('')).toBeUndefined()
    expect(normalizeStructureRemotePdbId('   ')).toBeUndefined()
    expect(normalizeStructureRemotePdbId(42)).toBeUndefined()
    expect(normalizeStructureRemotePdbId(undefined)).toBeUndefined()
  })

  it('URL 只有固定模板这一条：主机写死、id 已规范化', () => {
    expect(structureRemoteUrl('1CRN')).toBe(`https://${STRUCTURE_REMOTE_HOST}/view/1CRN.pdb`)
    expect(STRUCTURE_REMOTE_HOST).toBe('files.rcsb.org')
    expect(structureRemoteFileName('1CRN')).toBe('1CRN.pdb')
  })
})

describe('远程结构加载：三态判决（复用既有词汇）', () => {
  it('白名单命中 + 由系统强制 ⇒ 允许', () => {
    for (const protection of ['os-sandbox', 'network-allowlist'] as const) {
      const decision = decideStructureRemoteLoad({
        allowlist: [STRUCTURE_REMOTE_HOST],
        protection
      })
      expect(decision.decision).toBe('allow')
    }
  })

  it('白名单未命中 ⇒ 拒（即使保护级别是 os-sandbox：被挡住的去处问用户也没用）', () => {
    const decision = decideStructureRemoteLoad({
      allowlist: ['example.org'],
      protection: 'os-sandbox'
    })
    expect(decision.decision).toBe('deny')
    if (decision.decision !== 'deny') throw new Error('expected a refusal')
    expect(decision.reason).toBe('not-allowlisted')
    expect(decision.detail).toContain(STRUCTURE_REMOTE_HOST)
  })

  it('内置禁运名单**先于**白名单：显式列进白名单也不放行', () => {
    const deniedHost = '169.254.169.254'
    const decision = decideStructureRemoteLoad({
      allowlist: [deniedHost],
      protection: 'os-sandbox',
      host: deniedHost
    })
    expect(decision.decision).toBe('deny')
    if (decision.decision !== 'deny') throw new Error('expected a refusal')
    expect(decision.reason).toBe('denied-host')
  })

  it('拿不出强制力时是**问**，不是允许也不是拒', () => {
    const unprotected = decideStructureRemoteLoad({
      allowlist: [STRUCTURE_REMOTE_HOST],
      protection: 'unprotected'
    })
    expect(unprotected.decision).toBe('ask')

    // 闸门关着（白名单不限制）同样要问：没有策略在强制，就不该替用户点头。
    const noAllowlist = decideStructureRemoteLoad({
      allowlist: undefined,
      protection: 'os-sandbox'
    })
    expect(noAllowlist.decision).toBe('ask')
  })

  it('把上限与拒绝词表摆出来，别让调用方自己编一个数', () => {
    expect(STRUCTURE_REMOTE_MAX_BYTES).toBe(8 * 1024 * 1024)
  })
})

// --- D7 第二片：来源登记表 -------------------------------------------------------------------
describe('结构来源登记表：写侧与读侧由同一条约定钉住', () => {
  it('每个**预测**来源的落点，视图侧的事实条都认得出引擎；实验来源则一个字的事实都不给', () => {
    for (const source of Object.values(STRUCTURE_REMOTE_SOURCES)) {
      const directory = structureRemoteRelativeDirectory(source)
      const path = `/workspaces/s1/${directory ? `${directory}/` : ''}${source.fileName('X')}`
      const engine = engineForPredictionPath(path)
      if (source.predicted) {
        // 写进去的，视图一定读得出来 —— 这就是「打通」的全部保证。
        expect(engine?.id).toBe(source.engineId)
      } else {
        // 实验结构落工作区根：视图**不许**把它当成预测产物（实验与预测不能混为一谈）。
        expect(engine).toBeUndefined()
      }
    }
  })

  it('每个来源的主机都不是禁运目的地（否则界面上那条路永远只剩一个拒）', () => {
    for (const source of Object.values(STRUCTURE_REMOTE_SOURCES)) {
      expect(isHostDenied(source.host)).toBe(false)
    }
    expect(STRUCTURE_REMOTE_SOURCES.pdb.host).toBe(STRUCTURE_REMOTE_HOST)
  })

  it('来源 id 不认识就是 undefined（调用方据此判 unknown-source，不回落）', () => {
    expect(structureRemoteSource('pdb')?.id).toBe('pdb')
    expect(structureRemoteSource('alphafold-db')?.id).toBe('alphafold-db')
    expect(structureRemoteSource('made-up')).toBeUndefined()
    expect(structureRemoteSource(undefined)).toBeUndefined()
    expect(structureRemoteSource(7)).toBeUndefined()
  })

  it('UniProt 登录号：6 位与 10 位都认，形状不对不认（**绝不截断**）', () => {
    expect(normalizeStructureRemoteUniProtId('p00533')).toBe('P00533')
    expect(normalizeStructureRemoteUniProtId(' A0A123B4C5 ')).toBe('A0A123B4C5')
    expect(normalizeStructureRemoteUniProtId('P0053')).toBeUndefined()
    expect(normalizeStructureRemoteUniProtId('1CRN')).toBeUndefined()
    expect(normalizeStructureRemoteUniProtId('')).toBeUndefined()
    expect(normalizeStructureRemoteUniProtId(42)).toBeUndefined()
  })

  it('AlphaFold 的固定模板与文件名（版本号是数据库的约定，不是调用方挑的）', () => {
    expect(structureRemoteAlphaFoldUrl('P00533')).toBe(
      'https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v4.pdb'
    )
    expect(structureRemoteAlphaFoldFileName('P00533')).toBe('AF-P00533-F1-model_v4.pdb')
    expect(STRUCTURE_REMOTE_SOURCES['alphafold-db'].host).toBe('alphafold.ebi.ac.uk')
  })
})
