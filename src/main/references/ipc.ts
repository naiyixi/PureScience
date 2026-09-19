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
import type { ImportedCitationStyle } from '../../shared/citation/csl'
import { fetchReferenceByIdentifier, type IdentifierKind } from './service'
import { createPdfDoiImportOwner, type PdfDocumentPorts } from './pdf-doi-owner'
import type { PdfDoiImportResult } from './pdf-doi-import'
import { ReferenceRepository } from './repository'
import { ReferenceService } from './service'
import { CitationStyleRepository, type CitationStyleClient } from './citation-style-repository'
import { CitationStyleService, type CitationStyleImportResult } from './citation-style-service'

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
  // Imports the references a PDF cites, by reading the DOIs off its pages (3.4).
  importDoisFromPdf(projectId: string, pdfPath: string, limit?: number): Promise<PdfDoiImportResult>
  attachPdf(referenceId: string, pdfManagedFileId: string | null): Promise<Reference>
  detachPdf(referenceId: string): Promise<Reference>
  // Citation-style layer (v1.65): imported CSL styles live application-wide; the renderer merges
  // them with the built-in styles and formats locally.
  listCitationStyles(): Promise<ImportedCitationStyle[]>
  importCitationStyle(input: { fileName: string; xml: string }): Promise<CitationStyleImportResult>
  removeCitationStyle(styleId: string): Promise<void>
}

export type ReferencesIpcModule = {
  handlers: ReferencesHandlers
  service: ReferenceService
  // Bound by the composition root once the PDF reader exists (see createReferencesIpcModule).
  bindPdfPorts: (ports: PdfDocumentPorts) => void
}

const createDefaultReferenceRepository = (): ReferenceRepository =>
  new ReferenceRepository(() => getProjectDbClient(resolveStorageRoot()))

// Same lazy-client seam for the citation-style store: it lives in the project database, so a
// schema-ensure failure can recover exactly like the reference library does.
const createDefaultCitationStyleRepository = (): CitationStyleRepository =>
  new CitationStyleRepository(
    async () => (await getProjectDbClient(resolveStorageRoot())) as unknown as CitationStyleClient
  )

// Constructs the references module without installing an Electron transport (same seam as compute).
export const createReferencesIpcModule = (
  repository: ReferenceRepository = createDefaultReferenceRepository(),
  options: {
    resolvePdfFingerprint?: (projectId: string, managedFileId: string) => Promise<string | null>
  } = {},
  citationStyleRepository: CitationStyleRepository = createDefaultCitationStyleRepository()
): ReferencesIpcModule => {
  const service = new ReferenceService(repository, options)
  const citationStyles = new CitationStyleService(citationStyleRepository)
  // The PDF reader lives in the settings/pdf module and is created later in the composition root, so it
  // arrives through a holder rather than forcing the creation order. Until it is bound, the import
  // reports a named failure instead of pretending a document was read.
  const pdfHolder: { ports?: PdfDocumentPorts } = {}
  const pdfDoi = createPdfDoiImportOwner({
    pdf: {
      open: async (path, projectId) => {
        if (!pdfHolder.ports) throw new Error('The PDF reader is not available yet.')
        return pdfHolder.ports.open(path, projectId)
      },
      pages: async (docId, start, end) => {
        if (!pdfHolder.ports) throw new Error('The PDF reader is not available yet.')
        return pdfHolder.ports.pages(docId, start, end)
      }
    },
    references: {
      resolveByIdentifier: async (kind, identifier, projectId) => {
        const draft = await fetchReferenceByIdentifier(kind, identifier)
        return draft ? { ...draft, projectId } : undefined
      },
      // The library's add call reports the created record or the records it collided with; the import
      // only needs to know which of the two happened and which reference it maps to.
      addReference: async (input) => {
        const result = await service.addReference(input)
        return result.status === 'created'
          ? { status: 'created' as const, referenceId: result.reference.id }
          : { status: 'duplicate' as const, referenceId: result.duplicateOf[0]?.id ?? '' }
      }
    }
  })
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
    fetchByIdentifier: (kind, identifier) => fetchReferenceByIdentifier(kind, identifier),
    importDoisFromPdf: (projectId, pdfPath, limit) =>
      pdfDoi.importFromPdf(projectId, pdfPath, limit === undefined ? {} : { limit }),
    attachPdf: (referenceId, pdfManagedFileId) => service.attachPdf(referenceId, pdfManagedFileId),
    detachPdf: (referenceId) => service.detachPdf(referenceId),
    listCitationStyles: () => citationStyles.listStyles(),
    importCitationStyle: (input) => citationStyles.importStyle(input),
    removeCitationStyle: (styleId) => citationStyles.removeStyle(styleId)
  }
  return {
    handlers,
    service,
    bindPdfPorts: (ports) => {
      pdfHolder.ports = ports
    }
  }
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
      'references:import-dois-from-pdf',
      (_event, projectId: string, pdfPath: string, limit?: number) =>
        handlers.importDoisFromPdf(projectId, pdfPath, limit)
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
    ipcMainHandle(
      'references:attach-pdf',
      (_event, referenceId: string, pdfManagedFileId: string | null) =>
        handlers.attachPdf(referenceId, pdfManagedFileId)
    )
    ipcMainHandle('references:detach-pdf', (_event, referenceId: string) =>
      handlers.detachPdf(referenceId)
    )
    ipcMainHandle('references:list-citation-styles', () => handlers.listCitationStyles())
    ipcMainHandle(
      'references:import-citation-style',
      (_event, input: { fileName: string; xml: string }) => handlers.importCitationStyle(input)
    )
    ipcMainHandle('references:remove-citation-style', (_event, styleId: string) =>
      handlers.removeCitationStyle(styleId)
    )
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { createDefaultReferenceRepository }
export type { AddReferenceResult } from '../../shared/references'
