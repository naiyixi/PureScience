import { describe, expect, it } from 'vitest'

import {
  TASK_CHECKPOINT_SCHEMA_VERSION,
  emptyTaskCheckpoint,
  evaluateCheckpointFreshness,
  fingerprintInputs,
  isTaskCheckpoint,
  mergeTaskCheckpoint
} from './task-checkpoint'

const NOW = '2026-09-10T12:00:00.000Z'

describe('task checkpoint contract', () => {
  it('fingerprints inputs order- and case-insensitively', () => {
    const a = fingerprintInputs(['Data/Counts.h5ad', 'v1.2'])
    const b = fingerprintInputs(['  v1.2 ', 'data/counts.h5ad'])
    expect(a).toBe(b)
    expect(a).toMatch(/^fnv1a-[0-9a-f]{8}$/)
    expect(fingerprintInputs(['data/counts.h5ad'])).not.toBe(a)
    expect(fingerprintInputs([])).toBe(fingerprintInputs(['  ']))
  })

  it('merges sections by identity, patch winning, without dropping recorded work', () => {
    const base = mergeTaskCheckpoint(
      emptyTaskCheckpoint('proj-1', NOW),
      {
        inputFingerprint: fingerprintInputs(['exp-1']),
        activeStep: 'structure',
        verifiedFacts: [{ key: 'uniprot:SHANK2', value: 'Q9UPX8', source: 'uniprot.org' }],
        installedPackages: [{ name: 'scanpy', manager: 'python', version: '1.10.0' }],
        computedOutputs: [{ label: 'pLDDT table', path: 'out/plddt.csv' }]
      },
      NOW
    )

    const merged = mergeTaskCheckpoint(
      base,
      {
        activeStep: 'single-cell',
        verifiedFacts: [
          { key: 'uniprot:shank2', value: 'Q9UPX8-2', source: 'uniprot.org', verifiedAt: NOW }
        ],
        notes: ['PDB 6YQK rejected: wrong isoform']
      },
      '2026-09-10T13:00:00.000Z'
    )

    expect(merged.verifiedFacts).toHaveLength(1)
    expect(merged.verifiedFacts[0].value).toBe('Q9UPX8-2')
    expect(merged.installedPackages.map((entry) => entry.name)).toEqual(['scanpy'])
    expect(merged.computedOutputs.map((output) => output.label)).toEqual(['pLDDT table'])
    expect(merged.activeStep).toBe('single-cell')
    expect(merged.notes).toEqual(['PDB 6YQK rejected: wrong isoform'])
    expect(merged.updatedAt).toBe('2026-09-10T13:00:00.000Z')
  })

  it('drops empty entries and caps oversized fields', () => {
    const merged = mergeTaskCheckpoint(
      emptyTaskCheckpoint('proj-1', NOW),
      {
        verifiedFacts: [
          { key: '   ', value: 'x', source: 's' },
          { key: 'k', value: '  ', source: 's' },
          { key: 'long', value: 'v'.repeat(5000), source: 's' }
        ],
        notes: ['   ', 'kept']
      },
      NOW
    )
    expect(merged.verifiedFacts).toHaveLength(1)
    expect(merged.verifiedFacts[0].value.length).toBeLessThanOrEqual(2000)
    expect(merged.notes).toEqual(['kept'])
  })

  it('reports staleness when the input fingerprint differs (G4)', () => {
    const checkpoint = mergeTaskCheckpoint(
      emptyTaskCheckpoint('proj-1', NOW),
      {
        inputFingerprint: fingerprintInputs(['exp-1'])
      },
      NOW
    )

    expect(evaluateCheckpointFreshness(checkpoint, fingerprintInputs(['exp-1'])).status).toBe(
      'fresh'
    )
    const stale = evaluateCheckpointFreshness(checkpoint, fingerprintInputs(['exp-2']))
    expect(stale.status).toBe('stale')
    expect(stale.status === 'stale' ? stale.reason : '').toContain('Inputs changed')
    expect(
      evaluateCheckpointFreshness({ inputFingerprint: '' }, fingerprintInputs(['exp-1'])).status
    ).toBe('stale')
  })

  it('validates the schema version and shape on load', () => {
    const checkpoint = emptyTaskCheckpoint('proj-1', NOW)
    expect(checkpoint.schemaVersion).toBe(TASK_CHECKPOINT_SCHEMA_VERSION)
    expect(isTaskCheckpoint(checkpoint)).toBe(true)
    expect(isTaskCheckpoint({ ...checkpoint, schemaVersion: 0 })).toBe(false)
    expect(isTaskCheckpoint({ ...checkpoint, verifiedFacts: undefined })).toBe(false)
    expect(isTaskCheckpoint(null)).toBe(false)
  })
})
