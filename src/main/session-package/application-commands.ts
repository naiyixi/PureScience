import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'

import type {
  ExportSessionPackageRequest,
  ExportSessionPackageResult
} from '../../shared/session-package'
import type {
  SessionPackageImportRequest,
  SessionPackageImportResult
} from '../../shared/session-package-import'

// The portable-session package crosses THREE surfaces (window, local Web, headless CLI), and until this
// file existed the two directions it needs only had Electron IPC identities: the window could call them,
// and a Web request had no command to reach. They are application commands now — one registry, one owner,
// one set of refusals — and the Web profile is where the headless CLI actually lands.
//
// Neither command takes a dialog. `destinationPath`/`packagePath` are the whole transport: the owner
// writes to the path it is given and refuses with `no-destination` when none is supplied, so a Web caller
// is never promised a sheet it cannot show. The Electron adapter keeps the sheet for the window (see
// `ipc.ts`), which is the only surface where a human is looking at one.

/**
 * What the two commands delegate to. Purpose-built rather than a `Pick<>` of an owner: the export owner
 * takes a second, per-call dialog argument that a Web caller must not be able to supply, and the import
 * is a function, not an owner method. Both are narrowed to one request in, one result out.
 */
type SessionPackageCommandOwner = Readonly<{
  exportPackage: (request: ExportSessionPackageRequest) => Promise<ExportSessionPackageResult>
  importPackage: (request: SessionPackageImportRequest) => Promise<SessionPackageImportResult>
}>

type SessionPackageApplicationCommandDependencies = SessionPackageCommandOwner

const sessionPackageApplicationCommands = Object.freeze({
  exportPackage: defineApplicationCommand<
    'sessions:export-package',
    readonly [ExportSessionPackageRequest],
    ExportSessionPackageResult
  >('sessions:export-package'),
  importPackage: defineApplicationCommand<
    'sessions:import-package',
    readonly [SessionPackageImportRequest],
    SessionPackageImportResult
  >('sessions:import-package')
})

const sessionPackageApplicationCommandGroup = defineApplicationCommandGroup('session-package', [
  sessionPackageApplicationCommands.exportPackage,
  sessionPackageApplicationCommands.importPackage
] as const)

const registerSessionPackageApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: SessionPackageCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(sessionPackageApplicationCommandGroup, {
      'sessions:export-package': ({ args }) => dependencies.exportPackage(args[0]),
      'sessions:import-package': ({ args }) => dependencies.importPackage(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { sessionPackageApplicationCommandGroup, registerSessionPackageApplicationCommands }
export type { SessionPackageApplicationCommandDependencies, SessionPackageCommandOwner }
