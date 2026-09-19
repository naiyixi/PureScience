import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'

import type { ReferencesHandlers } from './ipc'

type OwnerArgs<Owner, Method extends keyof Owner> = Owner[Method] extends (
  ...args: infer Args
) => unknown
  ? Readonly<Args>
  : never

type OwnerResult<Owner, Method extends keyof Owner> = Owner[Method] extends (
  ...args: never[]
) => infer Result
  ? Awaited<Result>
  : never

// The owner surface application commands delegate to: the renderer handlers of the library module.
type ReferencesCommandOwner = Pick<
  ReferencesHandlers,
  | 'list'
  | 'add'
  | 'remove'
  | 'listCollections'
  | 'createCollection'
  | 'deleteCollection'
  | 'addToCollection'
  | 'removeFromCollection'
  | 'merge'
  | 'fetchByIdentifier'
  | 'attachPdf'
  | 'detachPdf'
  | 'importDoisFromPdf'
  | 'listCitationStyles'
  | 'importCitationStyle'
  | 'removeCitationStyle'
>

const referencesApplicationCommands = Object.freeze({
  list: defineApplicationCommand<
    'references:list',
    OwnerArgs<ReferencesCommandOwner, 'list'>,
    OwnerResult<ReferencesCommandOwner, 'list'>
  >('references:list'),
  add: defineApplicationCommand<
    'references:add',
    OwnerArgs<ReferencesCommandOwner, 'add'>,
    OwnerResult<ReferencesCommandOwner, 'add'>
  >('references:add'),
  remove: defineApplicationCommand<
    'references:remove',
    OwnerArgs<ReferencesCommandOwner, 'remove'>,
    OwnerResult<ReferencesCommandOwner, 'remove'>
  >('references:remove'),
  listCollections: defineApplicationCommand<
    'references:list-collections',
    OwnerArgs<ReferencesCommandOwner, 'listCollections'>,
    OwnerResult<ReferencesCommandOwner, 'listCollections'>
  >('references:list-collections'),
  createCollection: defineApplicationCommand<
    'references:create-collection',
    OwnerArgs<ReferencesCommandOwner, 'createCollection'>,
    OwnerResult<ReferencesCommandOwner, 'createCollection'>
  >('references:create-collection'),
  deleteCollection: defineApplicationCommand<
    'references:delete-collection',
    OwnerArgs<ReferencesCommandOwner, 'deleteCollection'>,
    OwnerResult<ReferencesCommandOwner, 'deleteCollection'>
  >('references:delete-collection'),
  addToCollection: defineApplicationCommand<
    'references:add-to-collection',
    OwnerArgs<ReferencesCommandOwner, 'addToCollection'>,
    OwnerResult<ReferencesCommandOwner, 'addToCollection'>
  >('references:add-to-collection'),
  removeFromCollection: defineApplicationCommand<
    'references:remove-from-collection',
    OwnerArgs<ReferencesCommandOwner, 'removeFromCollection'>,
    OwnerResult<ReferencesCommandOwner, 'removeFromCollection'>
  >('references:remove-from-collection'),
  merge: defineApplicationCommand<
    'references:merge',
    OwnerArgs<ReferencesCommandOwner, 'merge'>,
    OwnerResult<ReferencesCommandOwner, 'merge'>
  >('references:merge'),
  fetchByIdentifier: defineApplicationCommand<
    'references:fetch-by-identifier',
    OwnerArgs<ReferencesCommandOwner, 'fetchByIdentifier'>,
    OwnerResult<ReferencesCommandOwner, 'fetchByIdentifier'>
  >('references:fetch-by-identifier'),
  importDoisFromPdf: defineApplicationCommand<
    'references:import-dois-from-pdf',
    OwnerArgs<ReferencesCommandOwner, 'importDoisFromPdf'>,
    OwnerResult<ReferencesCommandOwner, 'importDoisFromPdf'>
  >('references:import-dois-from-pdf'),
  attachPdf: defineApplicationCommand<
    'references:attach-pdf',
    OwnerArgs<ReferencesCommandOwner, 'attachPdf'>,
    OwnerResult<ReferencesCommandOwner, 'attachPdf'>
  >('references:attach-pdf'),
  detachPdf: defineApplicationCommand<
    'references:detach-pdf',
    OwnerArgs<ReferencesCommandOwner, 'detachPdf'>,
    OwnerResult<ReferencesCommandOwner, 'detachPdf'>
  >('references:detach-pdf'),
  listCitationStyles: defineApplicationCommand<
    'references:list-citation-styles',
    OwnerArgs<ReferencesCommandOwner, 'listCitationStyles'>,
    OwnerResult<ReferencesCommandOwner, 'listCitationStyles'>
  >('references:list-citation-styles'),
  importCitationStyle: defineApplicationCommand<
    'references:import-citation-style',
    OwnerArgs<ReferencesCommandOwner, 'importCitationStyle'>,
    OwnerResult<ReferencesCommandOwner, 'importCitationStyle'>
  >('references:import-citation-style'),
  removeCitationStyle: defineApplicationCommand<
    'references:remove-citation-style',
    OwnerArgs<ReferencesCommandOwner, 'removeCitationStyle'>,
    OwnerResult<ReferencesCommandOwner, 'removeCitationStyle'>
  >('references:remove-citation-style')
})

const referencesApplicationCommandGroup = defineApplicationCommandGroup('references', [
  referencesApplicationCommands.add,
  referencesApplicationCommands.addToCollection,
  referencesApplicationCommands.createCollection,
  referencesApplicationCommands.deleteCollection,
  referencesApplicationCommands.fetchByIdentifier,
  referencesApplicationCommands.list,
  referencesApplicationCommands.listCollections,
  referencesApplicationCommands.merge,
  referencesApplicationCommands.remove,
  referencesApplicationCommands.removeFromCollection,
  referencesApplicationCommands.importDoisFromPdf,
  referencesApplicationCommands.attachPdf,
  referencesApplicationCommands.detachPdf,
  referencesApplicationCommands.listCitationStyles,
  referencesApplicationCommands.importCitationStyle,
  referencesApplicationCommands.removeCitationStyle
] as const)

// Registers the library channels as application commands delegating to the references owner.
const registerReferencesApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: ReferencesApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(referencesApplicationCommandGroup, {
      'references:list': ({ args }) => dependencies.references.list(args[0]),
      'references:add': ({ args }) => dependencies.references.add(args[0]),
      'references:remove': ({ args }) => dependencies.references.remove(args[0]),
      'references:list-collections': ({ args }) => dependencies.references.listCollections(args[0]),
      'references:create-collection': ({ args }) =>
        dependencies.references.createCollection(args[0]),
      'references:delete-collection': ({ args }) =>
        dependencies.references.deleteCollection(args[0]),
      'references:add-to-collection': ({ args }) =>
        dependencies.references.addToCollection(args[0], args[1]),
      'references:remove-from-collection': ({ args }) =>
        dependencies.references.removeFromCollection(args[0], args[1]),
      'references:merge': ({ args }) => dependencies.references.merge(args[0], args[1]),
      'references:fetch-by-identifier': ({ args }) =>
        dependencies.references.fetchByIdentifier(args[0], args[1]),
      'references:import-dois-from-pdf': ({ args }) =>
        dependencies.references.importDoisFromPdf(args[0], args[1], args[2]),
      'references:attach-pdf': ({ args }) => dependencies.references.attachPdf(args[0], args[1]),
      'references:detach-pdf': ({ args }) => dependencies.references.detachPdf(args[0]),
      'references:list-citation-styles': () => dependencies.references.listCitationStyles(),
      'references:import-citation-style': ({ args }) =>
        dependencies.references.importCitationStyle(args[0]),
      'references:remove-citation-style': ({ args }) =>
        dependencies.references.removeCitationStyle(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

type ReferencesApplicationCommandDependencies = Readonly<{
  references: ReferencesCommandOwner
}>

export { referencesApplicationCommandGroup, registerReferencesApplicationCommands }
export type { ReferencesApplicationCommandDependencies, ReferencesCommandOwner }
