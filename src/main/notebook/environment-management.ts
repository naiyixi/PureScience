import { stat } from 'node:fs/promises'

import type { NotebookKernelMetadata, NotebookLanguage } from '../../shared/notebook'
import type {
  EnvironmentInfo,
  ImportLockCoverage,
  ImportLockRequest,
  ImportLockResult,
  ManageEnvironmentsRequest,
  ManageEnvironmentsResult,
  ProvisionProgress
} from '../../shared/notebook-env'
import type { NotebookEnvironmentOperations } from './environment-operations'
import { ImportLockIncompleteError } from './provisioner'
import { measureDirectorySize } from '../storage/usage'
import { assertSafeEnvName, DEFAULT_PY_ENV, DEFAULT_R_ENV, envPrefix } from './runtime-paths'
import type { NotebookRuntimeRepairOwner } from './runtime-repair'

type NotebookEnvironmentManager = {
  createNamedEnvironment: (
    name: string,
    language: NotebookLanguage,
    packages?: string[]
  ) => Promise<EnvironmentInfo>
  // A7: build a named env from an external @EXPLICIT lock. OPTIONAL on the port on purpose: every test
  // double of the manager predates this capability, and a missing implementation is a NAMED failure at
  // call time (see importLock) rather than a compile error in a dozen unrelated fixtures. The only
  // production manager (DefaultRuntimeProvisioner) implements it.
  // Throws ImportLockIncompleteError (carrying the per-entry coverage) when ANY entry cannot be
  // verified — no prefix is created in that case.
  createNamedEnvironmentFromLock?: (
    name: string,
    language: NotebookLanguage,
    lock: string,
    options?: { allowDownload?: boolean; onProgress?: (progress: ProvisionProgress) => void }
  ) => Promise<{ environment: EnvironmentInfo; coverage: ImportLockCoverage }>
  listEnvironments: () => EnvironmentInfo[]
  removeEnvironment: (name: string) => EnvironmentInfo[]
}

type EnvironmentManagementSession = {
  kernelStatusEntries(): Array<[string, NotebookKernelMetadata['lastKnownStatus']]>
}

type NotebookEnvironmentManagementOptions = {
  runtimeRoot: string
  manager?: NotebookEnvironmentManager
  sessions: () => Iterable<EnvironmentManagementSession>
  ensureRecovered: () => Promise<void>
  assertPrefixRecoverable: (prefix: string) => void
  environmentOperations: Pick<NotebookEnvironmentOperations, 'runMutation'>
  runtimeRepair: Pick<NotebookRuntimeRepairOwner, 'completeRemovedManagedEnvironment'>
}

const isAppManagedEnvironment = (name: string): boolean =>
  name === DEFAULT_PY_ENV ||
  name === DEFAULT_R_ENV ||
  name.startsWith(`${DEFAULT_PY_ENV}-`) ||
  name.startsWith(`${DEFAULT_R_ENV}-`)

/** Owns named-environment validation, lifecycle ordering, and live-use protection. */
class NotebookEnvironmentManagementOwner {
  private manager: NotebookEnvironmentManager | undefined

  constructor(private readonly options: NotebookEnvironmentManagementOptions) {
    this.manager = options.manager
  }

  setManager(manager: NotebookEnvironmentManager): void {
    this.manager = manager
  }

  async manage(request: ManageEnvironmentsRequest): Promise<ManageEnvironmentsResult> {
    const manager = this.manager
    if (!manager) {
      throw new Error('Environment management is unavailable (no environment manager configured).')
    }

    switch (request.action) {
      case 'create': {
        const name = assertSafeEnvName(request.name)
        if (request.language !== 'python' && request.language !== 'r') {
          throw new Error('Creating an environment requires a language of "python" or "r".')
        }
        await this.options.ensureRecovered()
        this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
        return this.options.environmentOperations.runMutation(name, async () => {
          await manager.createNamedEnvironment(name, request.language, request.packages)
          return { environments: manager.listEnvironments() }
        })
      }
      case 'list':
        return { environments: await this.withSizes(manager.listEnvironments()) }
      case 'remove': {
        const name = assertSafeEnvName(request.name)
        if (isAppManagedEnvironment(name)) {
          throw new Error(
            `Environment "${name}" is app-managed and cannot be removed. Only environments you ` +
              'created with manage_environments(action:"create") can be removed.'
          )
        }
        if (this.isLive(name)) {
          throw new Error(
            `Environment "${name}" is in use by a running kernel — restart the notebook or ` +
              'wait for the run to finish before removing it.'
          )
        }
        await this.options.ensureRecovered()
        this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
        return this.options.environmentOperations.runMutation(name, async () => {
          // P0-10(b): measure the prefix BEFORE removing it. The removal path reported only a refreshed
          // list, so a user who freed 1.2 GB was told nothing — and "N bytes recovered" cannot be
          // reconstructed afterwards. Reuses the storage walker (inode-aware) instead of a second one.
          //
          // P0-10 (last open item): this number is REPORTED as bytes recovered, so a look that failed is
          // not zero bytes. `measureDirectorySize` answers `unavailable`/`unreadable` for a prefix that
          // cannot be listed, and the receipt then carries NO `freedBytes` — the agent's result mapper and
          // the window both read an absent reading as "no claim", while a 0 would be a number nobody
          // measured ("recovered 0 B" for a prefix that may have held gigabytes). A prefix that is simply
          // not there still measures 0: nothing was there, and that is a reading.
          const prefix = envPrefix(this.options.runtimeRoot, name)
          const measurement = await measureDirectorySize(prefix, new Set())
          const environments = manager.removeEnvironment(name)
          this.options.runtimeRepair.completeRemovedManagedEnvironment(name)
          return measurement.state === 'measured'
            ? { environments, freedBytes: measurement.bytes }
            : { environments }
        })
      }
    }
  }

  // P0-10(b): `EnvironmentInfo.sizeBytes` has existed in the contract and been surfaced by the agent
  // tool's result mapper, but nothing ever WROTE it — a read-side field with no producer, so both the
  // agent and the window showed nothing. Filled here, on the readout path only, by reusing the storage
  // walker (inode-aware) instead of a second one. A prefix that cannot be measured is left absent rather
  // than reported as zero: "could not look" and "nothing there" must not read alike.
  private async withSizes(environments: EnvironmentInfo[]): Promise<EnvironmentInfo[]> {
    const measured = await Promise.all(
      environments.map(async (environment) => {
        const prefix = envPrefix(this.options.runtimeRoot, environment.name)
        try {
          // Existence first: 0-byte is a different fact from a prefix that could not be looked at. Only a
          // prefix that exists is sized.
          await stat(prefix)
        } catch {
          return environment
        }
        // P0-10 (last open item): the walk reports a reading or `unavailable`. A tree that could only be
        // PARTLY walked is not "this prefix is 1.2 GB" — the unreadable subtree would silently shrink the
        // number shown to the reader, so the row goes without a size instead of with a wrong one.
        const measurement = await measureDirectorySize(prefix, new Set())
        return measurement.state === 'measured'
          ? { ...environment, sizeBytes: measurement.bytes }
          : environment
      })
    )
    return measured
  }

  // IC13: the Settings package dialog addresses an environment BY NAME. Only a NAMED environment the
  // app's own rules allow mutations in is addressable this way — the defaults (and the app-managed
  // versioned environments) are not, because the default prefix is additive-only by policy. Returns the
  // canonical name, or undefined so the caller refuses BY NAME instead of falling back to a default.
  async resolveNamedEnvironment(
    language: NotebookLanguage,
    name: string
  ): Promise<string | undefined> {
    const trimmed = name.trim()
    if (!trimmed || isAppManagedEnvironment(trimmed)) return undefined
    const manager = this.manager
    if (!manager) return undefined
    const match = manager
      .listEnvironments()
      .find(
        (candidate) =>
          candidate.language === language && candidate.name === trimmed && !candidate.isDefault
      )
    return match?.name
  }

  // A7 external-lock import. Same validation and mutation ordering as `create`, but the result is a
  // discriminated union: a lock entry that cannot be verified yields { status:'incomplete' } with the
  // NAMED per-entry reasons (and NO prefix), so the window never has to parse an error string.
  async importLock(
    request: ImportLockRequest,
    onProgress?: (progress: ProvisionProgress) => void
  ): Promise<ImportLockResult> {
    const manager = this.manager
    if (!manager) {
      throw new Error('Environment management is unavailable (no environment manager configured).')
    }
    const name = assertSafeEnvName(request.name)
    if (request.language !== 'python' && request.language !== 'r') {
      throw new Error('Importing a lock requires a language of "python" or "r".')
    }
    // bind(), not a detached reference: the manager is a real provisioner whose method reads `this.deps`
    // (`this.cache`, …). Extracting the function into a local and calling it loose drops the receiver and
    // fails at runtime with "Cannot read properties of undefined (reading 'deps')" — invisible to a stub
    // manager that never touches `this`. Found by the real-window run, not by the unit tests.
    const importFromLock = manager.createNamedEnvironmentFromLock?.bind(manager)
    if (!importFromLock) {
      throw new Error(
        'This environment manager does not support importing an environment from a lock.'
      )
    }
    await this.options.ensureRecovered()
    this.options.assertPrefixRecoverable(envPrefix(this.options.runtimeRoot, name))
    return this.options.environmentOperations.runMutation(name, async () => {
      try {
        const outcome = await importFromLock(name, request.language, request.lock, {
          allowDownload: request.allowDownload,
          onProgress
        })
        return { status: 'imported', environment: outcome.environment, coverage: outcome.coverage }
      } catch (error) {
        if (error instanceof ImportLockIncompleteError) {
          return { status: 'incomplete', coverage: error.coverage }
        }
        throw error
      }
    })
  }

  private isLive(name: string): boolean {
    for (const session of this.options.sessions()) {
      for (const [processKey, status] of session.kernelStatusEntries()) {
        if (processKey === 'repl' || status === 'terminated') continue
        if (processKey.slice(processKey.indexOf(':') + 1) === name) return true
      }
    }
    return false
  }
}

export { NotebookEnvironmentManagementOwner }
export type { NotebookEnvironmentManager }
