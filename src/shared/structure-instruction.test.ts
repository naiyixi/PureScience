// D5 中文口语解析：逐句钉住「哪句中文被解析成什么」，以及**解析不出来时是哪一种拒绝**。

import { describe, it, expect } from 'vitest'

import {
  parseStructureInstruction,
  resolveResidueCode,
  residueCodeForDisplay,
  structureInstructionParameterLine
} from './structure-instruction'

describe('残基名解析', () => {
  it('中文名 / 三字母 / 单字母都能落到 PDB 三字母码', () => {
    expect(resolveResidueCode('半胱氨酸')).toBe('CYS')
    expect(resolveResidueCode('CYS')).toBe('CYS')
    expect(resolveResidueCode('cys')).toBe('CYS')
    expect(resolveResidueCode('C')).toBe('CYS')
    expect(resolveResidueCode('甲硫氨酸')).toBe('MET')
    expect(resolveResidueCode('蛋氨酸')).toBe('MET')
  })

  it('表里没有的名字返回 undefined —— 不猜一个残基出来', () => {
    expect(resolveResidueCode('硒代半胱氨酸')).toBeUndefined()
    expect(resolveResidueCode('')).toBeUndefined()
    expect(residueCodeForDisplay('CYS')).toBe('半胱氨酸')
    expect(residueCodeForDisplay('XYZ')).toBe('XYZ')
  })
})

describe('一句中文 → 选择意图', () => {
  it('单残基：编号在名字前、名字在编号前、以及纯三字母写法都认', () => {
    const expected = {
      ok: true,
      kind: 'residue',
      residue: { residueStart: 145, residueEnd: 145 },
      residueName: 'CYS'
    }
    expect(parseStructureInstruction('145 号半胱氨酸')).toEqual(expected)
    expect(parseStructureInstruction('半胱氨酸 145')).toEqual(expected)
    expect(parseStructureInstruction('CYS145')).toEqual(expected)
    expect(parseStructureInstruction('Cys 145')).toEqual(expected)
  })

  it('带上链：两种中文语序都认，并把它写进参数行', () => {
    const parsed = parseStructureInstruction('A 链 145 号半胱氨酸')
    expect(parsed).toMatchObject({
      ok: true,
      kind: 'residue',
      residue: { chain: 'A', residueStart: 145, residueEnd: 145 }
    })
    expect(parseStructureInstruction('链 A 的 145 号半胱氨酸')).toMatchObject({
      ok: true,
      residue: { chain: 'A' }
    })
    expect(structureInstructionParameterLine(parsed as never)).toBe('单残基：链 A 残基 145 (CYS)')
  })

  it('区间：145 到 160 / 145-160 / 连接符写「至」都认', () => {
    for (const phrase of ['A 链 145 到 160', 'A 链 145-160', 'A 链 145 至 160', '链 A 145~160']) {
      expect(parseStructureInstruction(phrase)).toMatchObject({
        ok: true,
        kind: 'range',
        residue: { chain: 'A', residueStart: 145, residueEnd: 160 }
      })
    }
  })

  it('整链：整条链 / 整链 / 繁体都认（且不当作 1-N 区间）', () => {
    expect(parseStructureInstruction('整条链')).toEqual({ ok: true, kind: 'chain' })
    expect(parseStructureInstruction('A 链整条链')).toEqual({ ok: true, kind: 'chain', chain: 'A' })
    expect(parseStructureInstruction('整條鏈')).toEqual({ ok: true, kind: 'chain' })
  })

  it('半径邻域：D5 那句原话要解析成邻域而不是区间', () => {
    // 计划书里 D5 的例句。
    const parsed = parseStructureInstruction('把 145 号半胱氨酸 5 埃以内的残基标出来')
    expect(parsed).toMatchObject({
      ok: true,
      kind: 'neighborhood',
      radiusAngstrom: 5,
      reference: { residueStart: 145, residueEnd: 145 },
      residueName: 'CYS'
    })
    expect(structureInstructionParameterLine(parsed as never)).toBe(
      '邻域：半径 5 Å · 参考 残基 145 (CYS)'
    )
    // 半径写在前面、带链、带小数、用 Å 符号都认。
    expect(parseStructureInstruction('围绕 A 链 145 号半胱氨酸 4.5 Å 内的残基')).toMatchObject({
      ok: true,
      kind: 'neighborhood',
      radiusAngstrom: 4.5,
      reference: { chain: 'A', residueStart: 145 }
    })
    expect(parseStructureInstruction('链 A 残基 20 半径 8 埃 周围')).toMatchObject({
      ok: true,
      kind: 'neighborhood',
      radiusAngstrom: 8,
      reference: { chain: 'A', residueStart: 20 }
    })
  })
})

describe('解析不出来就具名拒绝（不静默什么都不发生）', () => {
  it('没有选择信息', () => {
    expect(parseStructureInstruction('')).toMatchObject({ ok: false, reason: 'no-selection-expressed' })
    expect(parseStructureInstruction('看一下这个结构')).toMatchObject({
      ok: false,
      reason: 'no-selection-expressed'
    })
    expect(parseStructureInstruction('附近')).toMatchObject({
      ok: false,
      reason: 'no-selection-expressed'
    })
  })

  it('残基名不在表里 ⇒ unknown-residue-name（并把那个词写进 detail）', () => {
    const parsed = parseStructureInstruction('145 号硒代半胱氨酸 5 埃以内')
    expect(parsed).toMatchObject({ ok: false, reason: 'unknown-residue-name' })
    expect(parsed.ok === false && parsed.detail).toContain('硒代半胱氨酸')
  })

  it('说了半径但没说围绕什么 ⇒ neighborhood-without-reference', () => {
    expect(parseStructureInstruction('5 埃以内的残基')).toMatchObject({
      ok: false,
      reason: 'neighborhood-without-reference'
    })
    expect(parseStructureInstruction('A 链 5 埃以内')).toMatchObject({
      ok: false,
      reason: 'neighborhood-without-reference'
    })
  })

  it('半径不是正数 ⇒ invalid-radius', () => {
    expect(parseStructureInstruction('145 号半胱氨酸 0 埃以内')).toMatchObject({
      ok: false,
      reason: 'invalid-radius'
    })
  })

  it('形状互相矛盾 ⇒ conflicting-shape', () => {
    expect(parseStructureInstruction('整条链 145 到 160')).toMatchObject({
      ok: false,
      reason: 'conflicting-shape'
    })
    expect(parseStructureInstruction('整条链 145 号半胱氨酸')).toMatchObject({
      ok: false,
      reason: 'conflicting-shape'
    })
  })
})
