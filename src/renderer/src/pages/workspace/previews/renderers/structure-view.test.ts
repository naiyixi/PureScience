import { describe, expect, it } from 'vitest'

import {
  availableColorSchemes,
  buildStructureSelection,
  detectStructureFormat,
  looksLikeAlphaFoldModel,
  plddtColorFor,
  resolveStructureSelectionRange,
  structureSelectionSelector,
  toStructureAtomRef,
  PLDDT_BANDS,
  type StructureAtomRef
} from './structure-view'
import {
  structureSelectionRangeLabel,
  type StructureSelection
} from '../../../../../../shared/structure-selection'

// 造一条 ATOM 行：B-factor 落在 PDB 规范的 61–66 列（0-based slice(60,66)）
const atomLine = (bFactor: string, serial = 1, resName = 'ALA'): string => {
  const base = `ATOM  ${String(serial).padStart(5)}  CA  ${resName} A${String(serial).padStart(4)}    `
  const coords = '   0.000   0.000   0.000  1.00'.padEnd(54 - base.length, ' ')
  const tail = `${bFactor.padStart(6)}           C  `
  return (base + coords + tail).slice(0, 80).padEnd(80, ' ')
}

const afModel = (count = 25, bFactor = '88.75'): string =>
  Array.from({ length: count }, (_, i) => atomLine(bFactor, i + 1)).join('\n')

describe('detectStructureFormat', () => {
  it('读扩展名：mmCIF 与 PDB 各自归位', () => {
    expect(detectStructureFormat('7VH8.cif', 'anything')).toBe('cif')
    expect(detectStructureFormat('model.mmcif', 'anything')).toBe('cif')
    expect(detectStructureFormat('1CRN.pdb', 'anything')).toBe('pdb')
    expect(detectStructureFormat('entry.ent', 'anything')).toBe('pdb')
  })

  it('扩展名不带信息时看内容首部：data_ 块 + _atom_site 字段 ⇒ cif', () => {
    const cif = 'data_7VH8\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\nATOM 1\n'
    expect(detectStructureFormat('download (3)', cif)).toBe('cif')
    expect(detectStructureFormat('download (4)', 'ATOM      1  CA  ALA A   1\n')).toBe('pdb')
  })

  it('头部很长、_atom_site 出现在 4 KB 之后也认得出来（真 RCSB mmCIF 的形状）', () => {
    // 实测 1CRN.cif 69,506 B：head 里 `_atom_site.` 落在 4 KB 之后 ⇒ 曾经被判成 pdb。
    // 这条用例把真实形状钉住：头部塞满 _cell./_entity./_struct. 字段，loop_ 与 _atom_site. 放在最后。
    const padding = Array.from(
      { length: 200 },
      (_, i) => `_struct_conf.id ${i}\n_struct_conf.conf_type_id HELIX_P`
    ).join('\n')
    const cif = `data_1CRN\n#\n${padding}\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\nATOM 1\n`
    expect(cif.length).toBeGreaterThan(4096)
    expect(cif.indexOf('_atom_site.')).toBeGreaterThan(4096)
    expect(detectStructureFormat('download', cif)).toBe('cif')
  })

  it('认不出就回落到 pdb —— 与改动前一致，不让"认不出"变成新失败路径', () => {
    expect(detectStructureFormat('mystery.bin', 'nonsense')).toBe('pdb')
  })
})

describe('looksLikeAlphaFoldModel', () => {
  it('AF- 命名 + B-factor 列是 0–100 的小数 ⇒ 是 AlphaFold 产物', () => {
    expect(looksLikeAlphaFoldModel('AF-P00533-F1-model_v4.pdb', afModel())).toBe(true)
  })

  it('仅名字像不算（B-factor 超出 0–100）', () => {
    expect(looksLikeAlphaFoldModel('AF-P00533-F1.pdb', afModel(25, '120.00'))).toBe(false)
  })

  it('仅数值像也不算（没有 AF- 命名）', () => {
    expect(looksLikeAlphaFoldModel('3ert.pdb', afModel())).toBe(false)
  })

  it('原子太少不下结论（避免用两行就判一份结构是预测模型）', () => {
    expect(looksLikeAlphaFoldModel('AF-X.pdb', afModel(5))).toBe(false)
  })
})

describe('配色', () => {
  it('pLDDT 只给 AlphaFold 产物 —— 对普通结构显示它等于给一个没有含义的颜色', () => {
    expect(availableColorSchemes(true)).toEqual(['spectrum', 'chain', 'plddt'])
    expect(availableColorSchemes(false)).toEqual(['spectrum', 'chain'])
  })

  it('色带按四档落位，边界值归入较高一档', () => {
    expect(plddtColorFor(95)).toBe(PLDDT_BANDS[0].color)
    expect(plddtColorFor(90)).toBe(PLDDT_BANDS[0].color)
    expect(plddtColorFor(89.9)).toBe('#65CBF3')
    expect(plddtColorFor(50)).toBe('#FFDB13')
    expect(plddtColorFor(10)).toBe('#FF7D45')
  })
})

describe('点击 → 选择（D2）', () => {
  const cys145: StructureAtomRef = { chain: 'A', resi: 145, resn: 'CYS' }
  const gly160: StructureAtomRef = { chain: 'A', resi: 160, resn: 'GLY' }
  const otherChain: StructureAtomRef = { chain: 'B', resi: 30, resn: 'ALA' }

  const build = (start: StructureAtomRef, end: StructureAtomRef): StructureSelection =>
    buildStructureSelection({
      structureId: 'artifact:abc',
      name: '7VH8.cif',
      format: 'cif' as const,
      contentDigest: 'sha256:aa',
      start,
      end,
      view: { style: 'cartoon', colorScheme: 'chain' }
    })

  it('3Dmol 的 atom 只认带链带编号的：其余的返回 undefined，不猜', () => {
    expect(toStructureAtomRef({ chain: 'A', resi: 145, resn: 'CYS', icode: ' ' })).toEqual(cys145)
    expect(toStructureAtomRef({ chain: 'A', resi: 145, resn: 'CYS', icode: 'B' })).toEqual({
      ...cys145,
      icode: 'B'
    })
    expect(toStructureAtomRef({ resi: 145 })).toBeUndefined()
    expect(toStructureAtomRef({ chain: 'A' })).toBeUndefined()
    expect(toStructureAtomRef({ chain: 'A', resi: 1.5 })).toBeUndefined()
    expect(toStructureAtomRef(null)).toBeUndefined()
  })

  it('第一次点击（或没有按 shift）＝ 单残基', () => {
    expect(resolveStructureSelectionRange(undefined, cys145, { extend: false })).toEqual({
      start: cys145,
      end: cys145,
      anchor: cys145
    })
    expect(resolveStructureSelectionRange(cys145, gly160, { extend: false })).toEqual({
      start: gly160,
      end: gly160,
      anchor: gly160
    })
  })

  it('同链按 shift ＝ 连续区间，且**倒着选也对**（端点与残基名一起规整）', () => {
    // 先点 160 再 shift 点 145：start 必须是 145 且名字取 145 那个原子的。
    const backwards = resolveStructureSelectionRange(gly160, cys145, { extend: true })
    expect(backwards.start).toEqual(cys145)
    expect(backwards.end).toEqual(gly160)
    expect(backwards.anchor).toEqual(cys145)
    expect(structureSelectionRangeLabel(build(backwards.start, backwards.end))).toBe(
      'chain A residues 145-160'
    )
  })

  it('跨链的 shift 点击退回单残基 —— 跨链不是一段连续区间，不编一个出来', () => {
    expect(resolveStructureSelectionRange(cys145, otherChain, { extend: true })).toEqual({
      start: otherChain,
      end: otherChain,
      anchor: otherChain
    })
  })

  it('组出来的选择带链、区间、残基名与视图参数', () => {
    const selection = build(cys145, gly160)
    expect(selection).toEqual({
      schemaVersion: 1,
      structureId: 'artifact:abc',
      name: '7VH8.cif',
      format: 'cif',
      contentDigest: 'sha256:aa',
      chain: 'A',
      residueStart: 145,
      residueEnd: 160,
      startResidue: 'CYS',
      endResidue: 'GLY',
      view: { style: 'cartoon', colorScheme: 'chain' }
    })
    expect(build(cys145, cys145)).toMatchObject({
      residueStart: 145,
      residueEnd: 145,
      startResidue: 'CYS',
      endResidue: 'CYS'
    })
  })

  it('高亮的选区是一个编号或一段编号，不自己拼数组', () => {
    expect(structureSelectionSelector(build(cys145, cys145))).toEqual({ chain: 'A', resi: 145 })
    expect(structureSelectionSelector(build(cys145, gly160))).toEqual({
      chain: 'A',
      resi: '145-160'
    })
  })
})
