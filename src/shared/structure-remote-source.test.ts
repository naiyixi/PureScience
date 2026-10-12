import { describe, expect, it } from 'vitest'

import {
  STRUCTURE_REMOTE_HOST,
  STRUCTURE_REMOTE_MAX_BYTES,
  decideStructureRemoteLoad,
  normalizeStructureRemotePdbId,
  structureRemoteFileName,
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
