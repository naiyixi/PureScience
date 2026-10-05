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
  | 'setNotes'
  | 'detachPdf'
  | 'importDoisFromPdf'
  | 'importJournalMetrics'
  | 'listJournalMetrics'
  | 'mergeJournals'
  | 'listCitationStyles'
  | 'importCitationStyle'
  | 'removeCitationStyle'
  | 'getScreening'
  | 'listScreeningRuleRevisions'
  | 'appendScreeningRuleRevision'
  | 'startScreeningRun'
  | 'cancelScreeningRun'
  | 'setScreeningOverride'
  | 'setScreeningOverrides'
  | 'clearScreeningOverride'
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
  importJournalMetrics: defineApplicationCommand<
    'references:import-journal-metrics',
    OwnerArgs<ReferencesCommandOwner, 'importJournalMetrics'>,
    OwnerResult<ReferencesCommandOwner, 'importJournalMetrics'>
  >('references:import-journal-metrics'),
  listJournalMetrics: defineApplicationCommand<
    'references:list-journal-metrics',
    OwnerArgs<ReferencesCommandOwner, 'listJournalMetrics'>,
    OwnerResult<ReferencesCommandOwner, 'listJournalMetrics'>
  >('references:list-journal-metrics'),
  mergeJournals: defineApplicationCommand<
    'references:merge-journals',
    OwnerArgs<ReferencesCommandOwner, 'mergeJournals'>,
    OwnerResult<ReferencesCommandOwner, 'mergeJournals'>
  >('references:merge-journals'),
  attachPdf: defineApplicationCommand<
    'references:attach-pdf',
    OwnerArgs<ReferencesCommandOwner, 'attachPdf'>,
    OwnerResult<ReferencesCommandOwner, 'attachPdf'>
  >('references:attach-pdf'),
  setNotes: defineApplicationCommand<
    'references:set-notes',
    OwnerArgs<ReferencesCommandOwner, 'setNotes'>,
    OwnerResult<ReferencesCommandOwner, 'setNotes'>
  >('references:set-notes'),
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
  >('references:remove-citation-style'),
  getScreening: defineApplicationCommand<
    'references:get-screening',
    OwnerArgs<ReferencesCommandOwner, 'getScreening'>,
    OwnerResult<ReferencesCommandOwner, 'getScreening'>
  >('references:get-screening'),
  listScreeningRuleRevisions: defineApplicationCommand<
    'references:list-screening-rule-revisions',
    OwnerArgs<ReferencesCommandOwner, 'listScreeningRuleRevisions'>,
    OwnerResult<ReferencesCommandOwner, 'listScreeningRuleRevisions'>
  >('references:list-screening-rule-revisions'),
  appendScreeningRuleRevision: defineApplicationCommand<
    'references:append-screening-rule-revision',
    OwnerArgs<ReferencesCommandOwner, 'appendScreeningRuleRevision'>,
    OwnerResult<ReferencesCommandOwner, 'appendScreeningRuleRevision'>
  >('references:append-screening-rule-revision'),
  startScreeningRun: defineApplicationCommand<
    'references:start-screening-run',
    OwnerArgs<ReferencesCommandOwner, 'startScreeningRun'>,
    OwnerResult<ReferencesCommandOwner, 'startScreeningRun'>
  >('references:start-screening-run'),
  cancelScreeningRun: defineApplicationCommand<
    'references:cancel-screening-run',
    OwnerArgs<ReferencesCommandOwner, 'cancelScreeningRun'>,
    OwnerResult<ReferencesCommandOwner, 'cancelScreeningRun'>
  >('references:cancel-screening-run'),
  setScreeningOverride: defineApplicationCommand<
    'references:set-screening-override',
    OwnerArgs<ReferencesCommandOwner, 'setScreeningOverride'>,
    OwnerResult<ReferencesCommandOwner, 'setScreeningOverride'>
  >('references:set-screening-override'),
  setScreeningOverrides: defineApplicationCommand<
    'references:set-screening-overrides',
    OwnerArgs<ReferencesCommandOwner, 'setScreeningOverrides'>,
    OwnerResult<ReferencesCommandOwner, 'setScreeningOverrides'>
  >('references:set-screening-overrides'),
  clearScreeningOverride: defineApplicationCommand<
    'references:clear-screening-override',
    OwnerArgs<ReferencesCommandOwner, 'clearScreeningOverride'>,
    OwnerResult<ReferencesCommandOwner, 'clearScreeningOverride'>
  >('references:clear-screening-override')
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
  referencesApplicationCommands.importJournalMetrics,
  referencesApplicationCommands.listJournalMetrics,
  referencesApplicationCommands.mergeJournals,
  referencesApplicationCommands.attachPdf,
  referencesApplicationCommands.setNotes,
  referencesApplicationCommands.detachPdf,
  referencesApplicationCommands.listCitationStyles,
  referencesApplicationCommands.importCitationStyle,
  referencesApplicationCommands.removeCitationStyle,
  referencesApplicationCommands.appendScreeningRuleRevision,
  referencesApplicationCommands.cancelScreeningRun,
  referencesApplicationCommands.clearScreeningOverride,
  referencesApplicationCommands.getScreening,
  referencesApplicationCommands.listScreeningRuleRevisions,
  referencesApplicationCommands.setScreeningOverride,
  referencesApplicationCommands.setScreeningOverrides,
  referencesApplicationCommands.startScreeningRun
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
      'references:import-journal-metrics': ({ args }) =>
        dependencies.references.importJournalMetrics(args[0]),
      'references:list-journal-metrics': () => dependencies.references.listJournalMetrics(),
      'references:merge-journals': ({ args }) => dependencies.references.mergeJournals(args[0]),
      'references:attach-pdf': ({ args }) => dependencies.references.attachPdf(args[0], args[1]),
      'references:set-notes': ({ args }) => dependencies.references.setNotes(args[0], args[1]),
      'references:detach-pdf': ({ args }) => dependencies.references.detachPdf(args[0]),
      'references:list-citation-styles': () => dependencies.references.listCitationStyles(),
      'references:import-citation-style': ({ args }) =>
        dependencies.references.importCitationStyle(args[0]),
      'references:remove-citation-style': ({ args }) =>
        dependencies.references.removeCitationStyle(args[0]),
      'references:get-screening': ({ args }) => dependencies.references.getScreening(args[0]),
      'references:list-screening-rule-revisions': ({ args }) =>
        dependencies.references.listScreeningRuleRevisions(args[0]),
      'references:append-screening-rule-revision': ({ args }) =>
        dependencies.references.appendScreeningRuleRevision(args[0]),
      'references:start-screening-run': ({ args }) =>
        dependencies.references.startScreeningRun(args[0]),
      'references:cancel-screening-run': ({ args }) =>
        dependencies.references.cancelScreeningRun(args[0]),
      'references:set-screening-override': ({ args }) =>
        dependencies.references.setScreeningOverride(args[0]),
      'references:set-screening-overrides': ({ args }) =>
        dependencies.references.setScreeningOverrides(args[0]),
      'references:clear-screening-override': ({ args }) =>
        dependencies.references.clearScreeningOverride(args[0], args[1])
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
