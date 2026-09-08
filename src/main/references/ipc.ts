import {
  createIpcHandlerInstallationScope,
  ipcMainHandle,
  type IpcHandlerInstallation
} from '../ipc-handler-registry'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveStorageRoot } from '../storage-root'

import type {
  AddReferenceResult,
  CollectionItem,
  CreateReferenceCollectionInput,
  CreateReferenceInput,
  Reference,
  ReferenceCollection
} from '../../shared/references'
import { fetchReferenceByIdentifier, type IdentifierKind } from './service'
import { ReferenceRepository } from './repository'
import { ReferenceService } from './service'

// Renderer-callable surface of the project reference library (v1.51).
export type ReferencesHandlers = {
  list(projectId: string): Promise<Reference[]>
  add(input: CreateReferenceInput): Promise<AddReferenceResult>
  remove(id: string): Promise<void>
  listCollections(projectId: string): Promise<ReferenceCollection[]>
  createCollection(input: CreateReferenceCollectionInput): Promise<ReferenceCollection>
  deleteCollection(id: string): Promise<void>
  addToCollection(collectionId: string, referenceId: string): Promise<CollectionItem>
  removeFromCollection(collectionId: string, referenceId: string): Promise<void>
  merge(keeperId: string, duplicateIds: readonly string[]): Promise<Reference>
  fetchByIdentifier(kind: IdentifierKind, identifier: string): Promise<CreateReferenceInput | null>
}

export type ReferencesIpcModule = {
  handlers: ReferencesHandlers
  service: ReferenceService
}

const createDefaultReferenceRepository = (): ReferenceRepository =>
  new ReferenceRepository(() => getProjectDbClient(resolveStorageRoot()))

// Constructs the references module without installing an Electron transport (same seam as compute).
export const createReferencesIpcModule = (
  repository: ReferenceRepository = createDefaultReferenceRepository()
): ReferencesIpcModule => {
  const service = new ReferenceService(repository)
  const handlers: ReferencesHandlers = {
    list: (projectId) => service.listReferences(projectId),
    add: (input) => service.addReference(input),
    remove: (id) => service.deleteReference(id),
    listCollections: (projectId) => service.listCollections(projectId),
    createCollection: (input) => service.createCollection(input),
    deleteCollection: (id) => service.deleteCollection(id),
    addToCollection: (collectionId, referenceId) =>
      service.addToCollection(collectionId, referenceId),
    removeFromCollection: (collectionId, referenceId) =>
      service.removeFromCollection(collectionId, referenceId),
    merge: (keeperId, duplicateIds) => service.mergeReferences(keeperId, duplicateIds),
    fetchByIdentifier: (kind, identifier) => fetchReferenceByIdentifier(kind, identifier)
  }
  return { handlers, service }
}

// Installs the renderer-callable Electron adapter over a references module.
export const installReferencesIpcHandlers = (
  module: ReferencesIpcModule
): IpcHandlerInstallation => {
  const scope = createIpcHandlerInstallationScope()
  try {
    const { handlers } = module
    ipcMainHandle('references:list', (_event, projectId: string) => handlers.list(projectId))
    ipcMainHandle('references:add', (_event, input: CreateReferenceInput) => handlers.add(input))
    ipcMainHandle('references:remove', (_event, id: string) => handlers.remove(id))
    ipcMainHandle('references:list-collections', (_event, projectId: string) =>
      handlers.listCollections(projectId)
    )
    ipcMainHandle('references:create-collection', (_event, input: CreateReferenceCollectionInput) =>
      handlers.createCollection(input)
    )
    ipcMainHandle('references:delete-collection', (_event, id: string) =>
      handlers.deleteCollection(id)
    )
    ipcMainHandle(
      'references:add-to-collection',
      (_event, collectionId: string, referenceId: string) =>
        handlers.addToCollection(collectionId, referenceId)
    )
    ipcMainHandle(
      'references:remove-from-collection',
      (_event, collectionId: string, referenceId: string) =>
        handlers.removeFromCollection(collectionId, referenceId)
    )
    ipcMainHandle('references:merge', (_event, keeperId: string, duplicateIds: string[]) =>
      handlers.merge(keeperId, duplicateIds)
    )
    ipcMainHandle(
      'references:fetch-by-identifier',
      (_event, kind: IdentifierKind, identifier: string) =>
        handlers.fetchByIdentifier(kind, identifier)
    )
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { createDefaultReferenceRepository }
export type { AddReferenceResult } from '../../shared/references'
