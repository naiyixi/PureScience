// D3 测量：按模块头注释的配方独立复算一遍，并钉住「原子写全」与「不信输入」两件事。

import { describe, it, expect } from 'vitest'

import {
  STRUCTURE_MEASUREMENT_SCHEMA_VERSION,
  buildStructureMeasurementBlock,
  normalizeStructureMeasurement,
  structureMeasurementAtomCount,
  structureMeasurementComponents,
  structureMeasurementFingerprint,
  structureMeasurementLabel,
  structureMeasurementUnit,
  type StructureMeasurement
} from './structure-measurement'

// Independent implementation of the published recipe (hand-written, do not call the module's helper).
const recompute = (components: readonly string[]): string => {
  const joined = components.join('\u0000')
  let hash = 0x811c9dc5
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `structure-measurement:v1-${hash.toString(16).padStart(8, '0')}`
}

const distance = (overrides: Partial<StructureMeasurement> = {}): StructureMeasurement => ({
  schemaVersion: STRUCTURE_MEASUREMENT_SCHEMA_VERSION,
  structureId: 'file:/tmp/7VH8.cif',
  name: '7VH8.cif',
  format: 'cif',
  contentDigest: 'sha256:0f1e2d',
  kind: 'distance',
  atoms: [
    { chain: 'A', resi: 145, resiName: 'CYS', atomName: 'SG', serial: 1201 },
    { chain: 'A', resi: 160, resiName: 'GLY', atomName: 'CA', serial: 1302 }
  ],
  value: 3.82,
  ...overrides
})

const angle = (overrides: Partial<StructureMeasurement> = {}): StructureMeasurement =>
  distance({
    kind: 'angle',
    atoms: [
      { chain: 'A', resi: 140, resiName: 'ALA', atomName: 'CA', serial: 1100 },
      { chain: 'A', resi: 145, resiName: 'CYS', atomName: 'CA', serial: 1200 },
      { chain: 'A', resi: 150, resiName: 'GLY', atomName: 'CA', serial: 1300 }
    ],
    value: 109.5,
    ...overrides
  })

describe('measurement fingerprint', () => {
  it('matches a value written out by hand from the recipe', () => {
    expect(structureMeasurementComponents(distance())).toEqual([
      'structure-measurement:v1',
      'file:/tmp/7VH8.cif',
      'sha256:0f1e2d',
      'distance',
      'A:145.SG#1201',
      'A:160.CA#1302'
    ])
    expect(structureMeasurementFingerprint(distance())).toBe(
      recompute(structureMeasurementComponents(distance()))
    )
  })

  it('is stable for the same measurement and moves when a named atom moves', () => {
    expect(structureMeasurementFingerprint(distance())).toBe(
      structureMeasurementFingerprint(distance())
    )
    // The same residue pair but a different atom pair is a DIFFERENT measurement: residue-level wording
    // would hide that a CYS SG and a CYS CA are not the same distance.
    const otherAtom = distance({
      atoms: [
        { chain: 'A', resi: 145, resiName: 'CYS', atomName: 'CA', serial: 1200 },
        { chain: 'A', resi: 160, resiName: 'GLY', atomName: 'CA', serial: 1302 }
      ]
    })
    expect(structureMeasurementFingerprint(otherAtom)).not.toBe(
      structureMeasurementFingerprint(distance())
    )
    // Order matters: the angle's vertex is the second atom.
    const reordered = angle({
      atoms: [angle().atoms[2], angle().atoms[1], angle().atoms[0]]
    })
    expect(structureMeasurementFingerprint(reordered)).not.toBe(
      structureMeasurementFingerprint(angle())
    )
  })

  it('does not fold the measured value into the identity', () => {
    // The value follows the record; the fingerprint says WHICH measurement, not how big it came out.
    // (Two runs over identical content must agree; a changed structure changes the content digest.)
    expect(structureMeasurementFingerprint(distance({ value: 3.82 }))).toBe(
      structureMeasurementFingerprint(distance({ value: 9.99 }))
    )
    expect(structureMeasurementFingerprint(distance({ value: undefined }))).toBe(
      structureMeasurementFingerprint(distance())
    )
    expect(structureMeasurementFingerprint(distance({ contentDigest: '' }))).not.toBe(
      structureMeasurementFingerprint(distance())
    )
  })
})

describe('measurement wording', () => {
  it('names every atom, so "distance" has one meaning', () => {
    expect(structureMeasurementLabel(distance())).toBe('CYS145.SG — GLY160.CA: 3.82 Å')
    expect(structureMeasurementLabel(angle())).toBe('ALA140.CA – CYS145.CA – GLY150.CA: 109.5 °')
    expect(structureMeasurementUnit(distance())).toBe('Å')
    expect(structureMeasurementUnit(angle())).toBe('°')
  })

  it('says what was measured without inventing a value when none was recorded', () => {
    expect(structureMeasurementLabel(distance({ value: undefined }))).toBe('CYS145.SG — GLY160.CA')
    expect(buildStructureMeasurementBlock(distance({ value: undefined }))).toContain(
      '"value":"not-measured"'
    )
  })

  it('carries the atom identities and the fingerprint into the conversation block', () => {
    const block = buildStructureMeasurementBlock(distance())
    expect(block.startsWith('<purescience_structure_measurement>\n')).toBe(true)
    expect(block.endsWith('</purescience_structure_measurement>')).toBe(true)
    const payload = JSON.parse(
      block.split('\n').find((line) => line.startsWith('{')) ?? 'null'
    ) as Record<string, unknown>
    expect(payload).toMatchObject({
      kind: 'distance',
      value: 3.82,
      unit: 'Å',
      measurement: 'CYS145.SG — GLY160.CA: 3.82 Å',
      fingerprint: structureMeasurementFingerprint(distance())
    })
    expect(payload.atoms).toHaveLength(2)
  })
})

describe('normalizing untrusted input', () => {
  it('accepts a well-formed measurement and requires the right atom count per kind', () => {
    expect(normalizeStructureMeasurement(distance())).toEqual(distance())
    expect(normalizeStructureMeasurement(angle())).toEqual(angle())
    expect(structureMeasurementAtomCount('distance')).toBe(2)
    expect(structureMeasurementAtomCount('angle')).toBe(3)
    // Two atoms are not an angle; three are not a distance.
    expect(
      normalizeStructureMeasurement(angle({ atoms: angle().atoms.slice(0, 2) }))
    ).toBeUndefined()
    expect(normalizeStructureMeasurement(distance({ atoms: angle().atoms }))).toBeUndefined()
  })

  it('refuses half-formed atoms and non-finite values instead of coercing them', () => {
    expect(normalizeStructureMeasurement(undefined)).toBeUndefined()
    expect(
      normalizeStructureMeasurement({ ...distance(), atoms: [{ chain: 'A' }] })
    ).toBeUndefined()
    expect(
      normalizeStructureMeasurement({ ...distance(), atoms: [{ resi: 145 }, distance().atoms[1]] })
    ).toBeUndefined()
    expect(normalizeStructureMeasurement({ ...distance(), value: Number.NaN })).toBeUndefined()
    expect(normalizeStructureMeasurement({ ...distance(), kind: 'torsion' })).toBeUndefined()
    expect(normalizeStructureMeasurement({ ...distance(), structureId: '  ' })).toBeUndefined()
    // A missing value is allowed (measured, not yet computed) — it is not the same as zero.
    expect(
      normalizeStructureMeasurement({ ...distance(), value: undefined })?.value
    ).toBeUndefined()
    expect(normalizeStructureMeasurement({ ...distance(), value: 0 })?.value).toBe(0)
  })
})
