import { realpathSync } from 'node:fs'

import type { NotebookLanguage } from '../../shared/notebook'
import type {
  ImportLockRequest,
  ImportLockResult,
  NamedEnvironmentRequest,
  NamedEnvironmentResult,
  ProvisionProgress
} from '../../shared/notebook-env'
import type {
  EnvPackage,
  RuntimeEnablement,
  RuntimePackageMutation,
  RuntimeSelection,
  RuntimeSurvey,
  RuntimeUsage
} from '../../shared/notebook-runtime'
import {
  createExternalAdapter,
  createManagedAdapter,
  defaultExternalAdapterDeps
} from './runtime-adapters'
import {
  defaultDiscoveryDeps,
  discoverInterpreters,
  type DiscoveredInterpreter
} from './environment-discovery'
import { listEnvPackages } from './package-listing'
import type { InstallRequest, InstallResult } from './package-manager'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV } from './runtime-paths'
import { RuntimeRegistry } from './runtime-registry'
import { prepareExternalPythonRuntime, type AppOwnedExternalSelection } from './venv-overlay'

type RuntimeRegistryPort = Pick<RuntimeRegistry, 'survey' | 'readiness'>

// Settings presents languages in this order; keep survey results stable for existing callers.
const RUNTIME_LANGUAGES: readonly NotebookLanguage[] = ['python', 'r']

// Upper bound on concurrent package listings inside listPackageCounts (mirrors the bounded
// probe concurrency in environment-discovery): enough to fill the Settings badges quickly without
// a subprocess storm.
const PACKAGE_COUNT_CONCURRENCY = 4

// Persisted runtime state remains Settings-owned. This narrow port keeps the workflows independent of
// the broader Settings module while preserving its normalized read-after-write behavior.
type RuntimeSelectionSettings = {
  getRuntimeSelection(language: NotebookLanguage): Promise<RuntimeSelection | undefined>
  setRuntimeSelection(
    language: NotebookLanguage,
    selection: RuntimeSelection | null
  ): Promise<RuntimeSelection | undefined>
  getRuntimeEnablement(language: NotebookLanguage): Promise<RuntimeEnablement>
  setEnvironmentEnabled(
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ): Promise<RuntimeEnablement>
  setInstallAuthorized(
    language: NotebookLanguage,
    envId: string,
    authorized: boolean
  ): Promise<RuntimeEnablement>
  getManualInterpreters(language: NotebookLanguage): Promise<string[]>
  addManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
  removeManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
}

type RuntimeSelectionWorkflowDeps = {
  settingsService: RuntimeSelectionSettings
  // Resolve lazily so a data-root switch reaches discovery and overlay preparation immediately.
  runtimeRoot: () => string
  // Production uses the managed/external registry; tests use the same two-operation seam.
  registry?: RuntimeRegistryPort
  // An app-owned overlay must be ready before its selection becomes durable.
  prepareExternalPython?: (
    selection: AppOwnedExternalSelection,
    runtimeRoot: string
  ) => Promise<void>
  // Called only after disabled state is durable; force chooses stop-now instead of drain-and-close.
  onRuntimeDisabled?: (language: NotebookLanguage, envId: string, force?: boolean) => Promise<void>
  // Optional because sessions may not be composed yet during startup; absence means no live usage.
  describeRuntimeUsage?: (language: NotebookLanguage, envId: string) => RuntimeUsage
  // Injectable for tests so the package-listing workflows never spawn micromamba/pip/Rscript;
  // production defaults to listEnvPackages against the real env.
  listPackages?: (env: DiscoveredInterpreter) => Promise<EnvPackage[]>
  // A7 external-lock import. Production injects the notebook service's importEnvironmentFromLock
  // (validated name/language + crash-recovery ordering + per-env mutation lock). Absent in tests that
  // don't exercise the surface — calling it then is a guarded error, never a silent no-op.
  importLock?: (
    request: ImportLockRequest,
    onProgress?: (progress: ProvisionProgress) => void
  ) => Promise<ImportLockResult>
  // Named-environment management for the Settings panel (audit P0-8). Production injects the notebook
  // service's manageEnvironments, so the SAME validation and live-kernel refusal gate the window as the
  // agent. Absent in tests that do not exercise the surface → guarded error, never a silent no-op.
  manageNamedEnvironments?: (request: NamedEnvironmentRequest) => Promise<NamedEnvironmentResult>
  // IC13: install/remove packages from the Settings "Packages" dialog. Production injects the notebook
  // service's managePackages, so the window goes through the SAME package admission as the agent —
  // per-environment install authorization, disabled-runtime refusals, external-environment limits and
  // the environment mutation lock all apply, and their named refusals reach the screen verbatim. The
  // dep speaks the installer's own request type (the workflow has already resolved the target env).
  managePackages?: (request: InstallRequest) => Promise<InstallResult>
}

type RuntimeSelectionWorkflows = {
  survey(): Promise<RuntimeSurvey[]>
  listEnvironments(): Promise<{
    python: DiscoveredInterpreter[]
    r: DiscoveredInterpreter[]
  }>
  // Read-only installed-package inventory for one discovered env (Settings "Packages" dialog).
  listPackages(request: { language: NotebookLanguage; envId: string }): Promise<EnvPackage[]>
  // Bulk per-env package counts for the Settings card badges; null = the listing failed (badge
  // omitted). Non-runnable envs get no entry.
  listPackageCounts(request: { language: NotebookLanguage }): Promise<Record<string, number | null>>
  getEnablement(request: { language: NotebookLanguage }): Promise<RuntimeEnablement>
  describeUsage(request: { language: NotebookLanguage; envId: string }): Promise<RuntimeUsage>
  setSelection(request: {
    language: NotebookLanguage
    selection: RuntimeSelection | null
  }): Promise<RuntimeSurvey>
  setEnvironmentEnabled(request: {
    language: NotebookLanguage
    envId: string
    enabled: boolean
    force?: boolean
  }): Promise<RuntimeEnablement>
  setInstallAuthorized(request: {
    language: NotebookLanguage
    envId: string
    authorized: boolean
  }): Promise<RuntimeEnablement>
  register(request: { language: NotebookLanguage; path: string }): Promise<string[]>
  unregister(request: { language: NotebookLanguage; path: string }): Promise<string[]>
  // A7: materialize a named env from an external @EXPLICIT lock (Settings → Runtimes).
  importLock(
    request: ImportLockRequest,
    onProgress?: (progress: ProvisionProgress) => void
  ): Promise<ImportLockResult>
  // Audit P0-8: list the named environments (the set notebooks select from) and remove one.
  manageNamedEnvironments(request: NamedEnvironmentRequest): Promise<NamedEnvironmentResult>
  // IC13: install/remove packages in one discovered environment, through the same admission the agent's
  // manage_packages goes through. `envId` identifies the environment the dialog belongs to; the target
  // is resolved by discovery, so a stale id cannot silently retarget the install.
  managePackages(request: RuntimePackageMutation): Promise<InstallResult>
}

// Discovery reports an environment's `envId` as the interpreter's REALPATH — on macOS `/var` is a
// symlink to `/private/var`, and a conda env's `bin/python` is a symlink to `bin/python3.12` — while the
// surfaces that carry an identity across a round trip (the named-environment rows, the packages dialog)
// hand back the path they were given. Comparing those forms literally misses an environment that is
// literally the same one, so every lookup by path compares RESOLVED paths.
const sameEnvironmentPath = (a: string, b: string): boolean => {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

const findDiscoveredEnvironment = (
  discovered: readonly DiscoveredInterpreter[],
  envId: string
): DiscoveredInterpreter | undefined =>
  discovered.find(
    (candidate) =>
      sameEnvironmentPath(candidate.envId, envId) ||
      sameEnvironmentPath(candidate.interpreterPath, envId)
  )

// A key the app has ADDRESSED before — enabled true or false, or install-authorized — is proof the id
// names a real environment even while discovery cannot see it (discovery degrades to an empty list when
// its own probe fails, and refusing a known environment on that basis would turn a transient failure
// into "you cannot disable this runtime").
const isPersistedEnvironmentKey = (enablement: RuntimeEnablement, envId: string): boolean =>
  Object.prototype.hasOwnProperty.call(enablement.enabled, envId) ||
  Object.prototype.hasOwnProperty.call(enablement.installAuthorized, envId)

const createRuntimeSelectionWorkflows = (
  deps: RuntimeSelectionWorkflowDeps
): RuntimeSelectionWorkflows => {
  const registry =
    deps.registry ??
    new RuntimeRegistry({
      managed: createManagedAdapter({ runtimeRoot: deps.runtimeRoot }),
      external: createExternalAdapter(defaultExternalAdapterDeps())
    })

  // A selected external runtime must report readiness for its persisted path, not the unrelated PATH
  // interpreter returned by the source-wide survey.
  const buildSurvey = async (language: NotebookLanguage): Promise<RuntimeSurvey> => {
    const [selection, surveyed] = await Promise.all([
      deps.settingsService.getRuntimeSelection(language),
      registry.survey(language)
    ])
    const external =
      selection?.source === 'external'
        ? await registry.readiness(language, selection)
        : surveyed.external

    return { language, selection, managed: surveyed.managed, external }
  }

  // One language's discovered envs for the package-listing workflows: the manual-interpreter
  // catalog snapshot merged into discovery as a sync getter. listEnvironments keeps its own
  // two-language sweep (one shared discovery construction); these workflows need a single language.
  const discoverLanguageEnvs = async (
    language: NotebookLanguage
  ): Promise<DiscoveredInterpreter[]> => {
    const manual = await deps.settingsService.getManualInterpreters(language)
    return discoverInterpreters(
      language,
      defaultDiscoveryDeps(deps.runtimeRoot(), () => manual)
    )
  }

  // The validated listing path shared by both package workflows: only ever called with a DISCOVERED
  // env (see the envId lookup in listPackages), never with renderer-supplied paths.
  const listPackagesFor = (env: DiscoveredInterpreter): Promise<EnvPackage[]> => {
    const list =
      deps.listPackages ??
      ((target: DiscoveredInterpreter) =>
        listEnvPackages(target, { runtimeRoot: deps.runtimeRoot() }))
    return list(env)
  }

  return {
    survey: () => Promise.all(RUNTIME_LANGUAGES.map(buildSurvey)),
    listEnvironments: async () => {
      // Discovery expects a synchronous manual-path lookup, so snapshot both persisted catalogs first.
      const [manualPython, manualR] = await Promise.all([
        deps.settingsService.getManualInterpreters('python'),
        deps.settingsService.getManualInterpreters('r')
      ])
      const discovery = defaultDiscoveryDeps(deps.runtimeRoot(), (language) =>
        language === 'python' ? manualPython : manualR
      )
      const [python, r] = await Promise.all([
        discoverInterpreters('python', discovery),
        discoverInterpreters('r', discovery)
      ])
      return { python, r }
    },
    // Read-only installed-package inventory for one env (Settings "Packages" dialog). The envId is
    // validated against a FRESH discovery result — the renderer only names the env; the interpreter
    // path / provenance used for dispatch come from discovery, so an arbitrary renderer-supplied
    // path can never be probed.
    listPackages: async (request) => {
      const env = findDiscoveredEnvironment(
        await discoverLanguageEnvs(request.language),
        request.envId
      )
      if (!env) {
        throw new Error(`Unknown ${request.language} environment: ${request.envId}`)
      }
      return listPackagesFor(env)
    },
    // Bulk per-env package counts for the Settings card badges. ONE discovery sweep for the
    // language (not one per env — each sweep spawns probe subprocesses), then a listing per
    // runnable env with bounded concurrency so a machine with many envs doesn't spawn a burst of
    // subprocesses. A failed listing maps to null (the card simply omits its badge).
    listPackageCounts: async (request) => {
      const runnable = (await discoverLanguageEnvs(request.language)).filter((env) => env.runnable)
      const counts: Record<string, number | null> = {}
      let next = 0
      const worker = async (): Promise<void> => {
        for (let i = next++; i < runnable.length; i = next++) {
          const env = runnable[i]
          counts[env.envId] = await listPackagesFor(env)
            .then((packages) => packages.length)
            .catch(() => null)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(PACKAGE_COUNT_CONCURRENCY, runnable.length) }, () => worker())
      )
      return counts
    },
    getEnablement: (request) => deps.settingsService.getRuntimeEnablement(request.language),
    describeUsage: async (request) =>
      deps.describeRuntimeUsage?.(request.language, request.envId) ?? {
        running: 0,
        idle: 0,
        dormant: 0
      },
    setSelection: async (request): Promise<RuntimeSurvey> => {
      // Validate the exact external interpreter before persistence. R stays managed-only, and managed
      // selections remain runnable-by-provisioning without an eager interpreter probe.
      if (request.selection?.source === 'external') {
        if (request.language !== 'python') {
          throw new Error('R only supports the app-managed runtime.')
        }
        const readiness = await registry.readiness(request.language, request.selection)
        if (!readiness.runnable) {
          throw new Error(
            readiness.detail
              ? `That interpreter can't be used as a notebook runtime: ${readiness.detail}`
              : "That interpreter can't be used as a notebook runtime (not a runnable Python 3)."
          )
        }
        if (request.selection.appOwnedOverlay) {
          try {
            // Overlay creation and its protocol probe are a precondition: failure leaves Settings
            // unchanged, so later execution never observes a half-prepared runtime.
            await (deps.prepareExternalPython ?? prepareExternalPythonRuntime)(
              request.selection as AppOwnedExternalSelection,
              deps.runtimeRoot()
            )
          } catch (error) {
            throw new Error(
              `Could not prepare an isolated notebook runtime, so the selection was not saved: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
      }
      await deps.settingsService.setRuntimeSelection(request.language, request.selection)
      return buildSurvey(request.language)
    },
    setEnvironmentEnabled: async (request) => {
      // IC14-①: only an environment this app can ADDRESS may be toggled. The window names one by the
      // `envId` discovery reported; the runtimes a session binds to carry a `runtimeId`, which is a
      // DIFFERENT vocabulary. A stale or foreign id used to be persisted as a key nothing reads — the
      // call answered with a fresh map, the row looked switched, and no environment had changed. The
      // same principle IC13 applied to the package dialog: refuse by name rather than silently apply
      // the request somewhere it was not meant to land.
      const addressed =
        findDiscoveredEnvironment(await discoverLanguageEnvs(request.language), request.envId) !==
          undefined ||
        isPersistedEnvironmentKey(
          await deps.settingsService.getRuntimeEnablement(request.language),
          request.envId
        )
      if (!addressed) {
        throw new Error(`Unknown ${request.language} environment: ${request.envId}`)
      }
      const next = await deps.settingsService.setEnvironmentEnabled(
        request.language,
        request.envId,
        request.enabled
      )
      // Persist disable before revocation. A revoke failure is surfaced without rolling the setting
      // back, preventing a failed drain from silently re-enabling the runtime for new work.
      if (!request.enabled) {
        await deps.onRuntimeDisabled?.(request.language, request.envId, request.force)
      }
      return next
    },
    setInstallAuthorized: (request) =>
      deps.settingsService.setInstallAuthorized(
        request.language,
        request.envId,
        request.authorized
      ),
    register: (request) =>
      deps.settingsService.addManualInterpreter(request.language, request.path),
    unregister: (request) =>
      deps.settingsService.removeManualInterpreter(request.language, request.path),
    importLock: (request, onProgress) => {
      const run = deps.importLock
      if (!run) {
        throw new Error('Lock import is unavailable (no environment manager configured).')
      }
      return run(request, onProgress)
    },
    manageNamedEnvironments: (request) => {
      const run = deps.manageNamedEnvironments
      if (!run) {
        throw new Error('Named-environment management is unavailable.')
      }
      return run(request)
    },
    managePackages: async (request) => {
      const run = deps.managePackages
      if (!run) {
        throw new Error('Package install/uninstall is unavailable.')
      }
      // Resolve the environment the dialog belongs to against LIVE discovery — a stale or foreign id
      // fails here by name instead of retargeting the mutation at whatever happens to be the default.
      const discovered = await discoverLanguageEnvs(request.language)
      const discoveredEnv = findDiscoveredEnvironment(discovered, request.envId)
      // A NAMED environment is not a discovery entry — the panel's cards come from discovery, which only
      // classifies the app-managed defaults — yet it is the only place the app's own rules allow a
      // removal or a downgrade (the default environment is additive-only). So a request naming one is
      // served by name, through the same service call and the same admission as everything else.
      const named = discoveredEnv
        ? undefined
        : (await deps.manageNamedEnvironments?.({ action: 'list' }))?.environments.find(
            (candidate) =>
              candidate.language === request.language &&
              (candidate.interpreterPath === request.envId || candidate.name === request.envId)
          )
      if (!discoveredEnv && !named) {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error: 'That environment is no longer available. Reopen the dialog and try again.'
        }
      }
      // The admission addresses an environment by NAME (`request.environment`), falling back to the
      // language's managed default when none is given. So an environment with a name is addressed by
      // name (managed or not — the admission then applies its own rules), and only a NAMELESS entry
      // falls back: an app-managed one IS the default, anything else cannot be addressed at all and is
      // refused by name rather than guessed at.
      const environmentName = discoveredEnv?.condaEnv ?? named?.name
      if (!environmentName && discoveredEnv?.provenance !== 'app-managed') {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error:
            'This environment does not identify a package target, so the app cannot install into ' +
            'it. Use the app-managed environment, or manage this one yourself.'
        }
      }
      // The admission resolves the environment from the SESSION BINDING, never from `request.environment`
      // (package-admission.ts: `binding?.source === 'managed' && binding.envName ? … : default`), and the
      // window has no session. So the only environment a window request can actually act on is the
      // app-managed default — and a request that names anything else must be refused HERE, by name,
      // instead of being silently applied to the default (the mis-target this resolution exists to
      // prevent). A named environment is still reachable for the agent, which does have a binding.
      const addressesDefault =
        !environmentName ||
        (discoveredEnv?.provenance === 'app-managed' && !discoveredEnv?.condaEnv) ||
        discoveredEnv?.condaEnv === DEFAULT_PY_ENV ||
        discoveredEnv?.condaEnv === DEFAULT_R_ENV
      if (!addressesDefault) {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error:
            'The Settings package dialog manages the app-managed default environment. Managing "' +
            `${environmentName ?? request.envId}" needs a notebook session bound to it — ask the ` +
            'assistant, or manage that environment yourself.'
        }
      }
      return run({
        language: request.language,
        packages: [...request.packages],
        operation: request.operation ?? 'install',
        ...(request.usePip ? { usePip: true } : {})
      })
    }
  }
}

export { createRuntimeSelectionWorkflows }
export type { RuntimeSelectionWorkflowDeps, RuntimeSelectionWorkflows }
