// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TASK_CHECKPOINT_FILE_NAME, TaskCheckpointStore } from './task-checkpoint-store'

let root: string
let store: TaskCheckpointStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'task-checkpoint-'))
  store = new TaskCheckpointStore((projectId) => join(root, projectId))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('TaskCheckpointStore', () => {
  it('returns null when no checkpoint exists yet', async () => {
    await expect(store.read('proj-1')).resolves.toBeNull()
  })

  it('round-trips a merged checkpoint through an atomic write', async () => {
    const merged = await store.apply(
      'proj-1',
      {
        inputFingerprint: 'fnv1a-12345678',
        activeStep: 'structure',
        verifiedFacts: [{ key: 'uniprot:SHANK2', value: 'Q9UPX8', source: 'uniprot.org' }]
      },
      '2026-09-10T12:00:00.000Z'
    )

    const loaded = await store.read('proj-1')
    expect(loaded).toEqual(merged)
    expect(loaded?.verifiedFacts[0].value).toBe('Q9UPX8')

    // No stray temp files survive the rename.
    const entries = await readdir(join(root, 'proj-1'))
    expect(entries).toEqual([TASK_CHECKPOINT_FILE_NAME])
  })

  it('keeps earlier sections when a later patch only touches one', async () => {
    await store.apply(
      'proj-1',
      {
        verifiedFacts: [{ key: 'gene:SHANK2', value: 'ENSG00000162105', source: 'ensembl' }],
        installedPackages: [{ name: 'pydeseq2', manager: 'python' }]
      },
      '2026-09-10T12:00:00.000Z'
    )
    await store.apply(
      'proj-1',
      { computedOutputs: [{ label: 'DEG list', path: 'out/deg.csv' }] },
      '2026-09-10T12:30:00.000Z'
    )

    const loaded = await store.read('proj-1')
    expect(loaded?.verifiedFacts).toHaveLength(1)
    expect(loaded?.installedPackages).toHaveLength(1)
    expect(loaded?.computedOutputs).toHaveLength(1)
    expect(loaded?.updatedAt).toBe('2026-09-10T12:30:00.000Z')
  })

  it('treats corrupted or stale-schema files as absent', async () => {
    await store.apply('proj-1', { activeStep: 'step-1' }, '2026-09-10T12:00:00.000Z')
    const path = join(root, 'proj-1', TASK_CHECKPOINT_FILE_NAME)

    await writeFile(path, '{ not json', 'utf8')
    await expect(store.read('proj-1')).resolves.toBeNull()

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 0,
        projectId: 'proj-1',
        updatedAt: '',
        inputFingerprint: '',
        verifiedFacts: [],
        installedPackages: [],
        computedOutputs: [],
        notes: []
      }),
      'utf8'
    )
    await expect(store.read('proj-1')).resolves.toBeNull()

    // A fresh apply after corruption starts cleanly instead of failing.
    const recovered = await store.apply(
      'proj-1',
      { activeStep: 'step-2' },
      '2026-09-10T13:00:00.000Z'
    )
    expect(recovered.activeStep).toBe('step-2')
    await expect(readFile(path, 'utf8')).resolves.toContain('"step-2"')
  })
})
