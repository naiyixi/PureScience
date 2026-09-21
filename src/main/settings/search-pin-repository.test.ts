import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  GLOBAL_SEARCH_PIN_MAX_SETS,
  GlobalSearchPinError,
  type GlobalSearchPin
} from '../../shared/global-search-pins'

import { PinLimitError, PinNameConflictError, SearchPinRepository } from './search-pin-repository'

const roots: string[] = []

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'search-pins-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const repositoryFor = (
  storageRoot: string,
  options: { now?: () => number } = {}
): SearchPinRepository =>
  new SearchPinRepository({
    storageRoot,
    createId: (() => {
      let sequence = 0
      return () => `pin-${++sequence}`
    })(),
    now: options.now ?? (() => Date.parse('2026-09-21T10:00:00.000Z'))
  })

describe('SearchPinRepository', () => {
  it('saves a set and reads it back from disk', async () => {
    const root = await createRoot()
    const repository = repositoryFor(root)

    const saved = await repository.save({ name: 'Agent notes', filters: { role: 'agent' } })

    expect(saved).toEqual({
      schemaVersion: 1,
      id: 'pin-1',
      name: 'Agent notes',
      savedAt: '2026-09-21T10:00:00.000Z',
      filters: { role: 'agent' }
    })
    await expect(repository.list()).resolves.toEqual([saved])
    // Stored as JSON, so a reader outside the app can see what the set accepts.
    const onDisk = JSON.parse(await readFile(join(root, 'search-pins.json'), 'utf8')) as unknown
    expect(onDisk).toEqual([saved])
  })

  it('refuses a name another set already holds, and says which set holds it', async () => {
    const root = await createRoot()
    const repository = repositoryFor(root)
    const first = await repository.save({ name: 'Agent notes', filters: { role: 'agent' } })

    // The name is what an evidence line carries, so two sets sharing it would make the line ambiguous.
    await expect(
      repository.save({ name: 'agent NOTES', filters: { role: 'user' } })
    ).rejects.toBeInstanceOf(PinNameConflictError)
    await expect(
      repository.save({ name: 'agent NOTES', filters: { role: 'user' } })
    ).rejects.toMatchObject({ existingId: first.id })
    await expect(repository.list()).resolves.toHaveLength(1)
  })

  it('replaces the set it was given an id for, name and filters together', async () => {
    const root = await createRoot()
    const repository = repositoryFor(root)
    const first = await repository.save({ name: 'Agent notes', filters: { role: 'agent' } })

    const updated = await repository.save({
      id: first.id,
      name: 'Agent csv notes',
      filters: { role: 'agent', extensions: ['csv'] }
    })

    expect(updated.id).toBe(first.id)
    expect(updated.name).toBe('Agent csv notes')
    expect(updated.filters).toEqual({ role: 'agent', extensions: ['csv'] })
    await expect(repository.list()).resolves.toEqual([updated])
  })

  it('refuses an id that is not stored rather than quietly creating a new set', async () => {
    const root = await createRoot()
    const repository = repositoryFor(root)

    await expect(
      repository.save({ id: 'pin-9', name: 'Agent notes', filters: { role: 'agent' } })
    ).rejects.toMatchObject({ reason: 'missing-id' })
    await expect(repository.list()).resolves.toEqual([])
  })

  it('refuses a set with no filters, in the same words the shared contract uses', async () => {
    const root = await createRoot()
    const repository = repositoryFor(root)

    await expect(repository.save({ name: 'Everything', filters: {} })).rejects.toBeInstanceOf(
      GlobalSearchPinError
    )
    await expect(repository.save({ name: 'Everything', filters: {} })).rejects.toMatchObject({
      reason: 'empty-filters'
    })
  })

  it('refuses a nameless set', async () => {
    const root = await createRoot()
    const repository = repositoryFor(root)

    await expect(
      repository.save({ name: '   ', filters: { role: 'agent' } })
    ).rejects.toMatchObject({ reason: 'empty-name' })
  })

  it('stops at the documented number of sets', async () => {
    const root = await createRoot()
    const repository = repositoryFor(root)
    for (let index = 0; index < GLOBAL_SEARCH_PIN_MAX_SETS; index += 1) {
      await repository.save({ name: `Set ${index}`, filters: { role: 'agent' } })
    }

    await expect(
      repository.save({ name: 'One more', filters: { role: 'user' } })
    ).rejects.toBeInstanceOf(PinLimitError)
    await expect(repository.list()).resolves.toHaveLength(GLOBAL_SEARCH_PIN_MAX_SETS)
  })

  it('keeps the sets it can read and drops the entries it cannot', async () => {
    const root = await createRoot()
    await writeFile(
      join(root, 'search-pins.json'),
      JSON.stringify([
        {
          schemaVersion: 1,
          id: 'pin-good',
          name: 'Agent notes',
          savedAt: '2026-09-21T10:00:00.000Z',
          filters: { role: 'agent' }
        },
        // No filters: it would name "everything", so it is not a set.
        { schemaVersion: 1, id: 'pin-empty', name: 'Everything', savedAt: 'x', filters: {} },
        'not a set at all'
      ]),
      'utf8'
    )

    await expect(repositoryFor(root).list()).resolves.toEqual([
      {
        schemaVersion: 1,
        id: 'pin-good',
        name: 'Agent notes',
        savedAt: '2026-09-21T10:00:00.000Z',
        filters: { role: 'agent' }
      }
    ])
  })

  it('treats an unreadable file as "nothing saved yet" instead of failing the palette', async () => {
    const root = await createRoot()
    await writeFile(join(root, 'search-pins.json'), '{ not json', 'utf8')

    await expect(repositoryFor(root).list()).resolves.toEqual([])
    // ...and saving still works, because the file is rewritten from what it can read.
    await expect(
      repositoryFor(root).save({ name: 'Agent notes', filters: { role: 'agent' } })
    ).resolves.toMatchObject({ name: 'Agent notes' })
  })

  it('removes one set and reports whether it was there', async () => {
    const root = await createRoot()
    const repository = repositoryFor(root)
    const kept: GlobalSearchPin = await repository.save({
      name: 'Agent notes',
      filters: { role: 'agent' }
    })
    const removed = await repository.save({ name: 'User notes', filters: { role: 'user' } })

    await expect(repository.remove(removed.id)).resolves.toBe(true)
    await expect(repository.list()).resolves.toEqual([kept])
    await expect(repository.remove(removed.id)).resolves.toBe(false)
    await expect(repository.list()).resolves.toEqual([kept])
  })
})
