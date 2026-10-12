// D2：结构选择 notice 的三条口径 —— 块进内容、用户的话原样、没选择就一个字节都不动。

import { describe, it, expect } from 'vitest'

import { structureSelectionNotice } from './structure-context'
import {
  STRUCTURE_SELECTION_SCHEMA_VERSION,
  structureSelectionFingerprint,
  type StructureSelection
} from '../../shared/structure-selection'

const selection = (overrides: Partial<StructureSelection> = {}): StructureSelection => ({
  schemaVersion: STRUCTURE_SELECTION_SCHEMA_VERSION,
  structureId: 'file:/tmp/1crn.cif',
  name: '1crn.cif',
  format: 'cif',
  contentDigest: 'sha256:0f1e2d',
  chain: 'A',
  residueStart: 145,
  residueEnd: 160,
  startResidue: 'CYS',
  endResidue: 'GLY',
  view: { style: 'cartoon', colorScheme: 'chain' },
  ...overrides
})

describe('the structure selection notice', () => {
  it('carries the range and the fingerprint of the selection', () => {
    const notice = structureSelectionNotice({ structureSelection: selection() })

    expect(notice.startsWith('<purescience_structure_context>\n')).toBe(true)
    const payload = JSON.parse(
      notice.split('\n').find((line) => line.startsWith('{')) ?? 'null'
    ) as Record<string, unknown>
    expect(payload.range).toBe('chain A residues 145-160')
    expect(payload.structureId).toBe('file:/tmp/1crn.cif')
    expect(payload.fingerprint).toBe(structureSelectionFingerprint(selection()))
  })

  it('says nothing at all when the turn carries no selection', () => {
    expect(structureSelectionNotice({})).toBe('')
    expect(structureSelectionNotice({ structureSelection: undefined })).toBe('')
  })

  it('refuses a half-formed selection instead of injecting part of one', () => {
    // Every one of these is what a broken or hostile renderer could send.
    expect(structureSelectionNotice({ structureSelection: { chain: 'A' } as never })).toBe('')
    expect(
      structureSelectionNotice({
        structureSelection: { ...selection(), residueStart: '145' } as never
      })
    ).toBe('')
    expect(
      structureSelectionNotice({
        structureSelection: { ...selection(), view: undefined } as never
      })
    ).toBe('')
    expect(
      structureSelectionNotice({
        structureSelection: { ...selection(), structureId: '' } as never
      })
    ).toBe('')
  })

  it('does not touch the request it was handed', () => {
    const request = { structureSelection: selection() }
    const before = JSON.stringify(request)
    structureSelectionNotice(request)
    expect(JSON.stringify(request)).toBe(before)
  })
})
