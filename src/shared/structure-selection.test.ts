// D2 结构选择指纹：**按模块头注释里的配方独立复算一遍**，并钉住「同一选择 ⇒ 同一指纹」。
//
// 独立实现不是形式：指纹的意义是别人拿着分量表能算出同一个值。调本模块自己的 helper 只证明它等于自己。

import { describe, it, expect } from 'vitest'

import {
  STRUCTURE_SELECTION_SCHEMA_VERSION,
  buildStructureContextBlock,
  normalizeStructureSelection,
  structureSelectionComponents,
  structureSelectionFingerprint,
  structureSelectionRangeLabel,
  structureSelectionScope,
  type StructureSelection
} from './structure-selection'

// Third-party recomputation of the published recipe: 32-bit FNV-1a over the ordered components joined
// by NUL, prefixed with the schema tag. Written out by hand — do not replace with the module's helper.
const recompute = (components: readonly string[]): string => {
  const joined = components.join('\u0000')
  let hash = 0x811c9dc5
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  // Hard-coded the way the recipe states it (v2 since the component list grew) — do NOT read the
  // module's constant here, or this stops being an independent implementation.
  return `structure-selection:v2-${hash.toString(16).padStart(8, '0')}`
}

// The block is a tag, one prose sentence, then a JSON payload line: find the payload by shape rather
// than by line number, so adding a sentence to the block does not silently break this test.
const payloadOf = (block: string): Record<string, unknown> => {
  const line = block.split('\n').find((candidate) => candidate.startsWith('{'))
  if (!line) throw new Error('expected a JSON payload line in the structure context block')
  return JSON.parse(line) as Record<string, unknown>
}

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

describe('the selection fingerprint is recomputable from its components', () => {
  it('matches a value written out by hand from the recipe', () => {
    const s = selection()
    expect(structureSelectionComponents(s)).toEqual([
      'structure-selection:v2',
      'file:/tmp/1crn.cif',
      'sha256:0f1e2d',
      'A',
      '145',
      '160',
      'cartoon',
      'chain',
      // v2 components, always present so the list length carries no ambiguity.
      'derived',
      'no-neighborhood',
      'no-members'
    ])
    expect(structureSelectionFingerprint(s)).toBe(recompute(structureSelectionComponents(s)))
  })

  it('is the same value every time the same selection is recomputed', () => {
    expect(structureSelectionFingerprint(selection())).toBe(
      structureSelectionFingerprint(selection())
    )
  })

  it('moves when any one component moves', () => {
    const base = structureSelectionFingerprint(selection())
    expect(
      structureSelectionFingerprint(selection({ structureId: 'file:/tmp/2crn.cif' }))
    ).not.toBe(base)
    expect(structureSelectionFingerprint(selection({ chain: 'B' }))).not.toBe(base)
    expect(structureSelectionFingerprint(selection({ residueStart: 144 }))).not.toBe(base)
    expect(structureSelectionFingerprint(selection({ residueEnd: 161 }))).not.toBe(base)
    expect(
      structureSelectionFingerprint(selection({ view: { style: 'stick', colorScheme: 'chain' } }))
    ).not.toBe(base)
    expect(
      structureSelectionFingerprint(selection({ view: { style: 'cartoon', colorScheme: 'plddt' } }))
    ).not.toBe(base)
    // A different structural content under the same id is a different selection.
    expect(structureSelectionFingerprint(selection({ contentDigest: 'sha256:beef' }))).not.toBe(
      base
    )
    // Insertion codes are part of the residue identity, not decoration.
    expect(structureSelectionFingerprint(selection({ startInsertion: 'A' }))).not.toBe(base)
  })

  it('keeps "no digest recorded" distinct from a recorded digest', () => {
    const unrecorded = structureSelectionFingerprint(selection({ contentDigest: '' }))
    expect(unrecorded).not.toBe(structureSelectionFingerprint(selection()))
    // Two selections that both failed to record a digest still compare equal to each other — the
    // fingerprint never claims a digest it does not have.
    expect(unrecorded).toBe(structureSelectionFingerprint(selection({ contentDigest: '' })))
    expect(structureSelectionComponents(selection({ contentDigest: '' }))[2]).toBe('not-recorded')
  })
})

describe('range wording and scope', () => {
  it('says a single residue as a residue and a span as a range', () => {
    expect(structureSelectionScope(selection())).toBe('range')
    expect(structureSelectionRangeLabel(selection())).toBe('chain A residues 145-160')
    const single = selection({ residueEnd: 145 })
    expect(structureSelectionScope(single)).toBe('residue')
    expect(structureSelectionRangeLabel(single)).toBe('chain A residue 145')
  })

  it('treats an insertion code as part of the residue identity', () => {
    // 145 and 145B are two different residues in PDB numbering: the wording must not collapse them
    // into "residue 145", and the two ends must not both print the same code.
    const sameNumberDifferentResidue = selection({ residueEnd: 145, endInsertion: 'B' })
    expect(structureSelectionScope(sameNumberDifferentResidue)).toBe('range')
    expect(structureSelectionRangeLabel(sameNumberDifferentResidue)).toBe(
      'chain A residues 145-145B'
    )
    expect(
      structureSelectionRangeLabel(
        selection({ residueEnd: 145, startInsertion: 'A', endInsertion: 'A' })
      )
    ).toBe('chain A residue 145A')
  })
})

describe('normalizing untrusted renderer input', () => {
  it('rebuilds a valid selection and drops anything that is not one', () => {
    const valid = normalizeStructureSelection(selection())
    expect(valid).toEqual(selection())
    expect(normalizeStructureSelection(undefined)).toBeUndefined()
    expect(normalizeStructureSelection({ chain: 'A' })).toBeUndefined()
    // Half a view spec is not a view spec.
    expect(
      normalizeStructureSelection({ ...selection(), view: { style: 'cartoon' } })
    ).toBeUndefined()
    // Non-integer or missing residue endpoints are refused rather than coerced to 0.
    expect(normalizeStructureSelection({ ...selection(), residueStart: '145' })).toBeUndefined()
    expect(normalizeStructureSelection({ ...selection(), residueEnd: undefined })).toBeUndefined()
    // An unknown format is refused instead of being read as pdb.
    expect(normalizeStructureSelection({ ...selection(), format: 'xyz' })).toBeUndefined()
    expect(normalizeStructureSelection({ ...selection(), structureId: '   ' })).toBeUndefined()
  })

  it('orders a reversed range and carries its insertion codes with their endpoints', () => {
    const reversed = normalizeStructureSelection({
      ...selection(),
      residueStart: 160,
      residueEnd: 145,
      startResidue: 'GLY',
      endResidue: 'CYS',
      startInsertion: 'B',
      endInsertion: 'A'
    })
    expect(reversed).toMatchObject({
      residueStart: 145,
      residueEnd: 160,
      startResidue: 'CYS',
      endResidue: 'GLY',
      startInsertion: 'A',
      endInsertion: 'B'
    })
    expect(reversed && structureSelectionRangeLabel(reversed)).toBe('chain A residues 145A-160B')
  })

  it('records an absent digest as absent rather than inventing one', () => {
    const normalized = normalizeStructureSelection({ ...selection(), contentDigest: undefined })
    expect(normalized?.contentDigest).toBe('')
    expect(normalized && buildStructureContextBlock(normalized)).toContain(
      '"contentDigest":"not-recorded"'
    )
  })
})

describe('whole-chain and spatial-neighborhood selections (v2 kinds)', () => {
  const chainWide = selection({ kind: 'chain' as const })
  const members = [
    { chain: 'A', resi: 10 },
    { chain: 'A', resi: 11 },
    { chain: 'A', resi: 12 },
    { chain: 'A', resi: 145 },
    { chain: 'A', resi: 160 }
  ]
  const neighborhood = selection({
    kind: 'neighborhood' as const,
    residueStart: 10,
    residueEnd: 160,
    neighborhood: { radiusAngstrom: 5, ofChain: 'A', ofStart: 145, ofEnd: 160 },
    memberResidues: members
  })

  it('says an entire chain as an entire chain, not as a 1-46 range', () => {
    expect(structureSelectionScope(chainWide)).toBe('chain')
    expect(structureSelectionRangeLabel(chainWide)).toBe('chain A (entire chain)')
    expect(buildStructureContextBlock(chainWide)).toContain('selected an ENTIRE chain')
  })

  it('describes a neighborhood by its member list, never by its outer bounds', () => {
    expect(structureSelectionScope(neighborhood)).toBe('neighborhood')
    expect(structureSelectionRangeLabel(neighborhood)).toBe(
      '5 residues within 5 Å of chain A residue 145-160'
    )
    const block = buildStructureContextBlock(neighborhood)
    expect(block).toContain('NOT a contiguous range')
    const payload = payloadOf(block)
    expect(payload.memberResidues).toEqual(members)
    expect(payload.memberResidueCount).toBe(5)
    expect(payload.neighborhood).toEqual({
      radiusAngstrom: 5,
      ofChain: 'A',
      ofStart: 145,
      ofEnd: 160
    })
    expect(payload.scope).toBe('neighborhood')
  })

  it('fingerprints two neighborhoods at the same radius with different members differently', () => {
    // This is the whole reason the member list is a fingerprint component: same radius, same
    // reference, different residues is a DIFFERENT selection.
    const other = selection({
      kind: 'neighborhood' as const,
      residueStart: 10,
      residueEnd: 160,
      neighborhood: { radiusAngstrom: 5, ofChain: 'A', ofStart: 145, ofEnd: 160 },
      memberResidues: [
        { chain: 'A', resi: 10 },
        { chain: 'A', resi: 11 },
        { chain: 'A', resi: 12 },
        { chain: 'A', resi: 145 },
        { chain: 'A', resi: 159 }
      ]
    })
    expect(structureSelectionFingerprint(other)).not.toBe(
      structureSelectionFingerprint(neighborhood)
    )
    // A different radius over the same members is different too.
    expect(
      structureSelectionFingerprint(
        selection({
          kind: 'neighborhood' as const,
          residueStart: 10,
          residueEnd: 160,
          neighborhood: { radiusAngstrom: 8, ofChain: 'A', ofStart: 145, ofEnd: 160 },
          memberResidues: members
        })
      )
    ).not.toBe(structureSelectionFingerprint(neighborhood))
  })

  it('refuses a neighborhood without its member list, and members on a non-neighborhood', () => {
    const noMembers = normalizeStructureSelection({
      ...neighborhood,
      memberResidues: undefined
    })
    expect(noMembers).toBeUndefined()
    const noReference = normalizeStructureSelection({
      ...neighborhood,
      neighborhood: undefined
    })
    expect(noReference).toBeUndefined()
    const contradictory = normalizeStructureSelection({
      ...selection(),
      memberResidues: [{ chain: 'A', resi: 1 }]
    })
    expect(contradictory).toBeUndefined()
    // A member list that is not a list of {chain, resi} refs is refused, not silently dropped —
    // a half-formed member list is exactly the input that would otherwise be read as "no members".
    const malformed = normalizeStructureSelection({ ...neighborhood, memberResidues: [10, 145] })
    expect(malformed).toBeUndefined()
  })

  it('sorts and de-duplicates members on the way in', () => {
    const normalized = normalizeStructureSelection({
      ...neighborhood,
      memberResidues: [
        { chain: 'A', resi: 160 },
        { chain: 'A', resi: 10 },
        { chain: 'A', resi: 145 },
        { chain: 'A', resi: 10 }
      ]
    })
    expect(normalized?.memberResidues).toEqual([
      { chain: 'A', resi: 10 },
      { chain: 'A', resi: 145 },
      { chain: 'A', resi: 160 }
    ])
    expect(normalized?.kind).toBe('neighborhood')
  })

  it('keeps members of OTHER chains — a pocket spanning two chains is not one chain', () => {
    const crossChain = selection({
      kind: 'neighborhood' as const,
      residueStart: 10,
      residueEnd: 160,
      neighborhood: { radiusAngstrom: 5, ofChain: 'A', ofStart: 145, ofEnd: 145 },
      memberResidues: [
        { chain: 'A', resi: 145 },
        { chain: 'B', resi: 30 }
      ]
    })
    expect(structureSelectionRangeLabel(crossChain)).toBe(
      '2 residues within 5 Å of chain A residue 145 (chains A, B)'
    )
    // Two members is not one member, and the other chain changes the fingerprint.
    expect(structureSelectionFingerprint(crossChain)).not.toBe(
      structureSelectionFingerprint(
        selection({
          kind: 'neighborhood' as const,
          residueStart: 10,
          residueEnd: 160,
          neighborhood: { radiusAngstrom: 5, ofChain: 'A', ofStart: 145, ofEnd: 145 },
          memberResidues: [{ chain: 'A', resi: 145 }]
        })
      )
    )
    const normalized = normalizeStructureSelection({
      ...crossChain,
      memberResidues: [
        { chain: 'B', resi: 30 },
        { chain: 'A', resi: 145 },
        { chain: 'A', resi: 145 }
      ]
    })
    expect(normalized?.memberResidues).toEqual([
      { chain: 'A', resi: 145 },
      { chain: 'B', resi: 30 }
    ])
  })

  it('keeps a D2-era record (no kind) derived, and hashes it as derived', () => {
    expect(structureSelectionScope(selection())).toBe('range')
    expect(structureSelectionComponents(selection())[8]).toBe('derived')
  })
})

describe('the conversation-context block', () => {
  it('names the structure, the range and the fingerprint instead of saying "the current structure"', () => {
    const block = buildStructureContextBlock(selection())
    expect(block.startsWith('<purescience_structure_context>\n')).toBe(true)
    expect(block.endsWith('</purescience_structure_context>')).toBe(true)
    expect(block).toContain('not refer to it as "the current structure"')
    const payload = payloadOf(block)
    expect(payload).toMatchObject({
      structureId: 'file:/tmp/1crn.cif',
      name: '1crn.cif',
      format: 'cif',
      contentDigest: 'sha256:0f1e2d',
      chain: 'A',
      residueStart: 145,
      residueEnd: 160,
      scope: 'range',
      range: 'chain A residues 145-160',
      view: { style: 'cartoon', colorScheme: 'chain' },
      fingerprint: structureSelectionFingerprint(selection())
    })
  })

  it('states a single-residue selection as that residue', () => {
    const single = selection({ residueEnd: 145, endResidue: 'CYS' })
    const payload = payloadOf(buildStructureContextBlock(single))
    expect(payload.scope).toBe('residue')
    expect(payload.range).toBe('chain A residue 145')
  })
})
