import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
  type GlobalSearchPin
} from '../../shared/global-search-pins'
import type { SearchPinRepository, SearchPinSaveInput } from './search-pin-repository'

// The registry is captured instead of installed: what matters here is which channels exist and what they
// hand to the owner, not how Electron wires them.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }
}))

const { SEARCH_PIN_IPC, createSearchPinCommandOwner, registerSearchPinIpcHandlers } =
  await import('./search-pin-ipc')

const pin = (overrides: Partial<GlobalSearchPin> = {}): GlobalSearchPin => ({
  schemaVersion: GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
  id: 'pin-1',
  name: 'Agent notes',
  savedAt: '2026-09-21T10:00:00.000Z',
  filters: { role: 'agent' },
  ...overrides
})

const repositoryStub = (): Pick<SearchPinRepository, 'list' | 'save' | 'remove'> => ({
  list: vi.fn(async () => [pin()]),
  save: vi.fn(async (input: SearchPinSaveInput) => pin({ name: input.name })),
  remove: vi.fn(async () => true)
})

beforeEach(() => {
  handlers.clear()
})

describe('createSearchPinCommandOwner', () => {
  it('passes every command through to the repository', async () => {
    const repository = repositoryStub()
    const owner = createSearchPinCommandOwner(repository as SearchPinRepository)

    await expect(owner.list()).resolves.toEqual([pin()])
    await expect(
      owner.save({ name: 'Agent notes', filters: { role: 'agent' } })
    ).resolves.toMatchObject({ name: 'Agent notes' })
    await expect(owner.remove('pin-1')).resolves.toBe(true)

    expect(repository.list).toHaveBeenCalledOnce()
    expect(repository.save).toHaveBeenCalledWith({
      name: 'Agent notes',
      filters: { role: 'agent' }
    })
    expect(repository.remove).toHaveBeenCalledWith('pin-1')
  })
})

describe('registerSearchPinIpcHandlers', () => {
  it('installs exactly the three saved-set channels, and no others', () => {
    registerSearchPinIpcHandlers(
      createSearchPinCommandOwner(repositoryStub() as SearchPinRepository)
    )

    expect([...handlers.keys()].sort()).toEqual(
      [SEARCH_PIN_IPC.LIST, SEARCH_PIN_IPC.REMOVE, SEARCH_PIN_IPC.SAVE].sort()
    )
  })

  it('returns the owner it registered, so the caller needs no second reference', () => {
    const owner = createSearchPinCommandOwner(repositoryStub() as SearchPinRepository)

    expect(registerSearchPinIpcHandlers(owner)).toBe(owner)
  })

  it('delegates a request to the same owner, with the arguments the channel carries', async () => {
    const repository = repositoryStub()
    registerSearchPinIpcHandlers(createSearchPinCommandOwner(repository as SearchPinRepository))

    await expect(handlers.get(SEARCH_PIN_IPC.LIST)?.({})).resolves.toEqual([pin()])
    await expect(
      handlers.get(SEARCH_PIN_IPC.SAVE)?.(
        {},
        { name: 'Human mtDNA', filters: { extensions: ['vcf'] } }
      )
    ).resolves.toMatchObject({ name: 'Human mtDNA' })
    await expect(handlers.get(SEARCH_PIN_IPC.REMOVE)?.({}, 'pin-1')).resolves.toBe(true)

    // The event object is Electron's, and none of these commands may read it: a saved filter set is the
    // user's own working state, and the sender must not be able to aim it at another project.
    expect(repository.save).toHaveBeenCalledWith({
      name: 'Human mtDNA',
      filters: { extensions: ['vcf'] }
    })
    expect(repository.remove).toHaveBeenCalledWith('pin-1')
  })
})
