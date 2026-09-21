// Saved search filter-set IPC (v1.67 unit: pinned filters). The renderer's surface for listing, saving and
// removing filter sets. Every mutation goes through the main-process repository (single writer). There is no
// agent-facing counterpart: a saved filter set is the researcher's own working state, and the only place it
// leaves the app is an evidence line the user copies on purpose.

import { ipcMainHandle } from '../ipc-handler-registry'
import type { GlobalSearchPin } from '../../shared/global-search-pins'
import type { SearchPinRepository, SearchPinSaveInput } from './search-pin-repository'

export const SEARCH_PIN_IPC = {
  LIST: 'search-pins:list',
  SAVE: 'search-pins:save',
  REMOVE: 'search-pins:remove'
} as const

export type SearchPinCommandOwner = {
  list: () => Promise<GlobalSearchPin[]>
  save: (input: SearchPinSaveInput) => Promise<GlobalSearchPin>
  remove: (id: string) => Promise<boolean>
}

export const createSearchPinCommandOwner = (
  repository: SearchPinRepository
): SearchPinCommandOwner => ({
  list: () => repository.list(),
  save: (input) => repository.save(input),
  remove: (id) => repository.remove(id)
})

export const registerSearchPinIpcHandlers = (
  owner: SearchPinCommandOwner
): SearchPinCommandOwner => {
  ipcMainHandle(SEARCH_PIN_IPC.LIST, () => owner.list())
  ipcMainHandle(SEARCH_PIN_IPC.SAVE, (_event, input: SearchPinSaveInput) => owner.save(input))
  ipcMainHandle(SEARCH_PIN_IPC.REMOVE, (_event, id: string) => owner.remove(id))
  return owner
}
