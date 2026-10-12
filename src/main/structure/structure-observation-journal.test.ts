import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_SESSION_OBSERVATIONS,
  STRUCTURE_OBSERVATIONS_DIR,
  projectStructureObservationWindow,
  readSessionStructureObservations,
  recordStructureObservation
} from './structure-observation-journal'
import type { StructureSelection } from '../../shared/structure-selection'

const selection = (residueStart: number): StructureSelection => ({
  schemaVersion: 2,
  structureId: 'artifact:artifact-1',
  name: 'crambin.pdb',
  format: 'pdb',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  chain: 'A',
  residueStart,
  residueEnd: residueStart,
  kind: 'residue',
  view: { style: 'cartoon', colorScheme: 'spectrum' }
})

describe('structure-observation-journal', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'structure-observations-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads a session that never recorded anything as not-recorded, not as unreadable', async () => {
    // "never recorded" and "the file is broken" are different answers; a reader must be able to tell
    // them apart, so the missing file is named rather than folded into one unavailable state.
    const journal = await readSessionStructureObservations(root, 'session-never-used')
    expect(journal).toEqual({ state: 'unavailable', reason: 'not-recorded' })
  })

  it('round-trips a selection and a measurement and keeps their recorded order', async () => {
    await recordStructureObservation(root, 'session-1', {
      kind: 'selection',
      selection: selection(22),
      recordedAt: '2026-10-12T10:00:00.000Z'
    })
    await recordStructureObservation(root, 'session-1', {
      kind: 'measurement',
      measurement: {
        schemaVersion: 1,
        structureId: 'artifact:artifact-1',
        name: 'crambin.pdb',
        format: 'pdb',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        kind: 'distance',
        atoms: [
          { chain: 'A', resi: 22, resiName: 'PRO' },
          { chain: 'A', resi: 26, resiName: 'CYS' }
        ],
        value: 12.34
      },
      recordedAt: '2026-10-12T10:05:00.000Z'
    })

    const journal = await readSessionStructureObservations(root, 'session-1')
    expect(journal.state).toBe('available')
    if (journal.state !== 'available') throw new Error('expected the journal to be readable')
    expect(journal.dropped).toBe(0)
    expect(journal.entries.map((entry) => entry.kind)).toEqual(['selection', 'measurement'])
    expect(journal.entries[0]?.selection?.residueStart).toBe(22)
    expect(journal.entries[1]?.measurement?.value).toBe(12.34)
  })

  it('keeps entries recorded in parallel instead of losing all but the last', async () => {
    // The naive read-modify-write drops everything but the final write while still reporting `dropped: 0`,
    // so this is the assertion that pins the serialisation, not an incidental one.
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        recordStructureObservation(root, 'session-race', {
          kind: 'selection',
          selection: selection(100 + index)
        })
      )
    )
    const journal = await readSessionStructureObservations(root, 'session-race')
    if (journal.state !== 'available') throw new Error('expected the journal to be readable')
    expect(journal.entries).toHaveLength(8)
    expect(new Set(journal.entries.map((entry) => entry.selection?.residueStart)).size).toBe(8)
  })

  it('drops the oldest entries at the cap and reports how many', async () => {
    for (let index = 0; index < MAX_SESSION_OBSERVATIONS + 3; index += 1) {
      await recordStructureObservation(root, 'session-capped', {
        kind: 'selection',
        selection: selection(index)
      })
    }
    const journal = await readSessionStructureObservations(root, 'session-capped')
    if (journal.state !== 'available') throw new Error('expected the journal to be readable')
    expect(journal.entries).toHaveLength(MAX_SESSION_OBSERVATIONS)
    expect(journal.dropped).toBe(3)
    // The kept window is the newest one: entry 0 is gone, the last one written is still there.
    expect(journal.entries.at(-1)?.selection?.residueStart).toBe(MAX_SESSION_OBSERVATIONS + 2)
    expect(journal.entries.some((entry) => entry.selection?.residueStart === 0)).toBe(false)
  })

  it('says unreadable for a damaged file and never throws out of a read', async () => {
    await recordStructureObservation(root, 'session-broken', {
      kind: 'selection',
      selection: selection(1)
    })
    await writeFile(
      join(root, STRUCTURE_OBSERVATIONS_DIR, 'session-broken.json'),
      'not json{',
      'utf8'
    )
    await expect(readSessionStructureObservations(root, 'session-broken')).resolves.toEqual({
      state: 'unavailable',
      reason: 'unreadable'
    })
  })

  it('recording never throws, even when the root cannot be written', async () => {
    // The recorder rides on a turn that has already succeeded: a journalling failure must not become a
    // turn failure, so this is asserted rather than assumed.
    await expect(
      recordStructureObservation('/dev/null/not-a-directory', 'session-1', {
        kind: 'selection',
        selection: selection(1)
      })
    ).resolves.toBeUndefined()
  })

  it('drops entries newer than the Version and reports how many', () => {
    const window = projectStructureObservationWindow(
      [
        { kind: 'selection', selection: selection(1), recordedAt: '2026-10-12T09:00:00.000Z' },
        { kind: 'selection', selection: selection(2), recordedAt: '2026-10-12T11:00:00.000Z' }
      ],
      '2026-10-12T10:00:00.000Z'
    )
    expect(window.windowKnown).toBe(true)
    expect(window.items.map((entry) => entry.selection?.residueStart)).toEqual([1])
    expect(window.afterWindow).toBe(1)
    expect(window.undated).toBe(0)
  })

  it('lists everything when the Version carries no parseable write time, and says so', () => {
    // No timestamp on the evidence means the window could not be enforced. Silently listing everything as
    // if it had been applied is the failure this asserts against.
    const entries = [
      {
        kind: 'selection' as const,
        selection: selection(1),
        recordedAt: '2026-10-12T09:00:00.000Z'
      }
    ]
    expect(projectStructureObservationWindow(entries, undefined).windowKnown).toBe(false)
    expect(projectStructureObservationWindow(entries, 'not a timestamp').windowKnown).toBe(false)
    for (const writtenAt of [undefined, 'not a timestamp']) {
      const window = projectStructureObservationWindow(entries, writtenAt)
      expect(window.items).toHaveLength(1)
      expect(window.afterWindow).toBe(0)
    }
  })

  it('never lets an unparseable stamp pass as inside the window', () => {
    const window = projectStructureObservationWindow(
      [
        { kind: 'selection', selection: selection(1), recordedAt: 'whenever' },
        { kind: 'selection', selection: selection(2), recordedAt: '2026-10-12T09:00:00.000Z' }
      ],
      '2026-10-12T10:00:00.000Z'
    )
    expect(window.items.map((entry) => entry.selection?.residueStart)).toEqual([2])
    expect(window.undated).toBe(1)
    expect(window.afterWindow).toBe(0)
  })

  it('writes valid JSON (the panel reads this file through the Version projection)', async () => {
    await recordStructureObservation(root, 'session-json', {
      kind: 'selection',
      selection: selection(7)
    })
    const raw = await readFile(join(root, STRUCTURE_OBSERVATIONS_DIR, 'session-json.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    expect(parsed).toMatchObject({ entries: [{ kind: 'selection' }], dropped: 0 })
  })
})
