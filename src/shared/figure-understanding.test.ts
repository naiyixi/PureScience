import { describe, expect, it } from 'vitest'

import {
  classifyFigure,
  describeFigureVerdict,
  FIG_UNDERSTANDING_ROUTES,
  type FigureClassVerdict
} from './figure-understanding'

const kindsOf = (verdict: FigureClassVerdict): string[] => verdict.signals.map((s) => s.kind)

describe('classifyFigure — 按图形类别分派', () => {
  it('把一个 Scheme 判成化学结构式，并点名是哪个标注投的票', () => {
    const verdict = classifyFigure({
      caption: 'Scheme 2. Synthesis of compound 7a from the corresponding aldehyde.',
      inFigureText: []
    })

    expect(verdict.class).toBe('chemical-structure')
    expect(kindsOf(verdict)).toContain('scheme-label')
    expect(verdict.signals.find((s) => s.kind === 'scheme-label')?.matched).toBe('Scheme 2')
    expect(verdict.signals.every((s) => s.where === 'caption')).toBe(true)
  })

  it('从图注里读出 PDB 号（带关键词那条路）', () => {
    const verdict = classifyFigure({
      caption: 'Figure 3. Overall structure (PDB 6LU7).',
      inFigureText: []
    })

    expect(verdict.class).toBe('protein-structure')
    if (verdict.class !== 'protein-structure') throw new Error('unreachable')
    expect(verdict.accessions).toEqual([{ kind: 'pdb', id: '6LU7', where: 'caption' }])
  })

  it('从图注里读出 UniProt 号', () => {
    const verdict = classifyFigure({
      caption: 'Domain architecture of UniProt: P00533 (EGFR).',
      inFigureText: []
    })

    expect(verdict.class).toBe('protein-structure')
    if (verdict.class !== 'protein-structure') throw new Error('unreachable')
    expect(verdict.accessions.map((a) => `${a.kind}:${a.id}`)).toEqual(['uniprot:P00533'])
  })

  it('没有关键词时，库号形状要配上结构性词才算（否则不予采信）', () => {
    const withContext = classifyFigure({
      caption: '1abc ribbon diagram of the kinase domain.',
      inFigureText: []
    })
    expect(withContext.class).toBe('protein-structure')
    if (withContext.class !== 'protein-structure') throw new Error('unreachable')
    expect(withContext.accessions.map((a) => `${a.kind}:${a.id}`)).toEqual(['pdb:1ABC'])

    const withoutContext = classifyFigure({
      caption: 'Results for cohort 2abc in 2024.',
      inFigureText: []
    })
    expect(withoutContext.class).not.toBe('protein-structure')
  })

  it('有结构性词但没有库号时，类别成立而库号为空 —— 调用方必须拒答而不是编一个', () => {
    const verdict = classifyFigure({
      caption: 'Ribbon diagram of the protein with the ligand bound.',
      inFigureText: []
    })

    expect(verdict.class).toBe('protein-structure')
    if (verdict.class !== 'protein-structure') throw new Error('unreachable')
    expect(verdict.accessions).toEqual([])
  })

  it('图表要两种不同种类的标记才算数', () => {
    const verdict = classifyFigure({
      caption: 'Dose–response curves; error bars show SEM; n = 6.',
      inFigureText: []
    })

    expect(verdict.class).toBe('chart')
    expect(new Set(kindsOf(verdict)).size).toBeGreaterThanOrEqual(2)
  })

  it('只有一种图表标记时判「信号不足」，绝不硬判成图表', () => {
    const verdict = classifyFigure({ caption: 'Data collected with n = 12.', inFigureText: [] })

    expect(verdict.class).toBe('undetermined')
    if (verdict.class !== 'undetermined') throw new Error('unreachable')
    expect(verdict.reason).toBe('insufficient-signals')
    expect(kindsOf(verdict)).toEqual(['sample-size'])
  })

  it('完全没有证据时拒答，并且**不**落到通用示意图（没有默认类别）', () => {
    const verdict = classifyFigure({ inFigureText: [] })

    expect(verdict.class).toBe('undetermined')
    if (verdict.class !== 'undetermined') throw new Error('unreachable')
    expect(verdict.reason).toBe('no-signals')
    expect(verdict.signals).toEqual([])
  })

  it('通用示意图只在明写这一类时成立', () => {
    const verdict = classifyFigure({
      caption: 'Workflow schematic of the screening pipeline.',
      inFigureText: []
    })
    expect(verdict.class).toBe('schematic')
  })

  it('两类信号同时出现时判「互相矛盾」并把两边的票都留下', () => {
    const verdict = classifyFigure({
      caption: 'Scheme 1 and the IC50 (nM) readouts.',
      inFigureText: []
    })

    expect(verdict.class).toBe('undetermined')
    if (verdict.class !== 'undetermined') throw new Error('unreachable')
    expect(verdict.reason).toBe('conflicting-signals')
    expect(kindsOf(verdict)).toContain('scheme-label')
    expect(kindsOf(verdict)).toContain('unit-axis')
  })

  it('图框内的文字项与图注分别标出来源', () => {
    const verdict = classifyFigure({
      caption: 'Scheme 3',
      inFigureText: ['Et3N, DMF', '7a, 82% yield']
    })

    expect(verdict.class).toBe('chemical-structure')
    expect(verdict.signals.some((s) => s.where === 'in-figure-text')).toBe(true)
  })

  it('读出来的那一行带着票（证据可复核），并且每类都写明允许派生什么', () => {
    const verdict = classifyFigure({ caption: 'Scheme 2' })
    const line = describeFigureVerdict(verdict)

    expect(line).toContain('chemical-structure')
    expect(line).toContain('scheme-label')
    expect(line).toContain('Scheme 2')

    for (const route of Object.values(FIG_UNDERSTANDING_ROUTES)) {
      expect(route.derivation).not.toBe('')
      expect(route.requires).not.toBe('')
    }
  })

  // 真机读数（`final_verdict.pdf` 第 1 页）当场抓到的形态：一张非化学的图只因图内写着 `R2` 就被判成
  // 化学结构式。弱记号**单独**不足以立类 —— 这两条用例把它钉死。
  it('单独一个取代基记号不足以立成化学结构式（R2 也可能是 R² 或行号）', () => {
    const verdict = classifyFigure({ inFigureText: ['R2'] })

    expect(verdict.class).toBe('undetermined')
    if (verdict.class !== 'undetermined') throw new Error('unreachable')
    expect(verdict.reason).toBe('insufficient-signals')
    expect(kindsOf(verdict)).toEqual(['substituent-token'])
  })

  it('两种不同种类的化学证据（试剂 + 取代基）才立类', () => {
    const verdict = classifyFigure({ inFigureText: ['Et3N', 'R1'] })

    expect(verdict.class).toBe('chemical-structure')
    expect(new Set(kindsOf(verdict)).size).toBeGreaterThanOrEqual(2)
  })
})
