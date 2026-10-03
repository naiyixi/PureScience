import { useLanguage, type TranslationKey } from '@/i18n'
import { useDialogFocusRestore } from '@/components/ui/dialog-focus-restore'
import {
  CheckCircle2,
  FolderInput,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Upload
} from 'lucide-react'
import { AlertDialog, Dialog } from 'radix-ui'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { DEFAULT_EGRESS_SETTINGS, type EgressSettings } from '../../../../shared/egress'
import type {
  EnvironmentInfo,
  ImportLockCoverage,
  ImportLockResult
} from '../../../../shared/notebook-env'
import {
  isEnvEnabled,
  type DiscoveredInterpreter,
  type EnvPackage,
  type RuntimeEnablement,
  type RuntimeSelection,
  type RuntimeSurvey,
  type RuntimeUsage
} from '../../../../shared/notebook-runtime'
import type { NotebookLanguage } from '../../../../shared/notebook'
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'
import { PythonIcon, RIcon } from './language-icons'

// Localized prose for the disable-impact dialog; placeholders survive the
// string-key translator (tests' `t` does not interpolate), so fill them here.
const describeDisableImpact = (
  t: (key: string) => string,
  usage: { running: number; idle: number } | undefined
): string => {
  if (!usage) return ''
  const active = usage.running + usage.idle
  const template = active === 1 ? t('runtimes.disableDescOne') : t('runtimes.disableDescMany')
  return template
    .replace('{active}', String(active))
    .replace('{running}', String(usage.running))
    .replace('{idle}', String(usage.idle))
}

// v4 Runtime Registry write surface: one CARD per discovered interpreter per language. Each card can
// be enabled/disabled (the agent only ever sees enabled envs); external envs additionally expose a
// separate, high-risk "allow package install" opt-in. A separate section drives the app-managed
// acquisition/download flow, and "Add interpreter…" registers the user's own interpreter into the
// discovery catalog. Effective enable/auth state loads from the PERSISTED per-language enablement
// (runtime.getEnablement), then refreshes from each setter's returned enablement.

const LANGUAGES: ReadonlyArray<{ id: NotebookLanguage; label: string; icon: React.JSX.Element }> = [
  { id: 'python', label: 'Python', icon: <PythonIcon /> },
  { id: 'r', label: 'R', icon: <RIcon /> }
]

type EnvLists = { python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }
type Enablements = Partial<Record<NotebookLanguage, RuntimeEnablement>>

type RuntimesPanelProps = {
  title: string
  description: React.ReactNode
  // Optional jump from the (off-state) protection card to Settings → Network. Absent in contexts
  // without a settings nav (e.g. onboarding), where the card then shows the off note without a CTA.
  onOpenNetwork?: () => void
}

// Human provider/type for the card badge (provenance + conda env name), e.g. "App-managed",
// "Conda: bio", "System".
const providerType = (env: DiscoveredInterpreter, t: (key: TranslationKey) => string): string => {
  if (env.provenance === 'app-managed') return t('settings.appManaged')
  if (env.provenance === 'agent-created') return t('settings.agentCreated')
  if (env.condaEnv) return `${t('settings.conda')}: ${env.condaEnv}`
  return t('settings.system')
}

// One-line readiness for a discovered env: version plus runnable/gap detail.
const envReadyLine = (env: DiscoveredInterpreter, t: (key: TranslationKey) => string): string => {
  const version = env.version ? ` · ${env.version}` : ''
  return env.runnable
    ? `${t('settings.ready')}${version}`
    : `${env.detail ?? t('settings.notRunnable')}${version}`
}

const managedLine = (
  runnable: boolean,
  preparing: boolean,
  t: (key: TranslationKey) => string,
  message?: string
): string => {
  if (preparing) return message ?? t('settings.downloadingManagedRuntime')
  return runnable ? t('settings.installedAndReady') : t('settings.managedRuntimeNotSetUp')
}

// A7 lock import: the two result lines. Placeholders survive the string-key translator (tests' `t`
// does not interpolate), so they are filled here — same convention as describeDisableImpact.
const importImportedLine = (
  t: (key: TranslationKey) => string,
  environmentName: string,
  coverage: ImportLockCoverage
): string =>
  t('runtimes.importLockImported')
    .replace('{name}', environmentName)
    .replace('{total}', String(coverage.total))
    .replace('{fromCache}', String(coverage.fromCache))
    .replace('{downloaded}', String(coverage.downloaded))

const importIncompleteLine = (
  t: (key: TranslationKey) => string,
  coverage: ImportLockCoverage
): string =>
  t('runtimes.importLockIncomplete')
    .replace('{missing}', String(coverage.missing.length))
    .replace('{total}', String(coverage.total))

const RuntimesPanel = ({
  title,
  description,
  onOpenNetwork
}: RuntimesPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [envs, setEnvs] = useState<EnvLists | null>(null)
  const [enablement, setEnablement] = useState<Enablements>({})
  const [loaded, setLoaded] = useState(false)
  // The persisted per-language selection, plus the notices the selection controls set. The selection
  // used to be loaded nowhere in the renderer at all: it was persisted, and invisible.
  const [surveys, setSurveys] = useState<RuntimeSurvey[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Network-protection status: mirrors the persisted egress master switch from Settings → Network
  // (the same source the NetworkPanel switch reads), fetched independently of runtime discovery so
  // the card renders even while envs are still loading. Optional-chaining guard: render tests stub
  // window.api without the settings namespace — when it is absent the card simply stays hidden.
  const [egress, setEgress] = useState<EgressSettings | undefined>(undefined)
  const [managedOperations, setManagedOperations] = useState<
    Partial<Record<NotebookLanguage, boolean>>
  >({})
  // Set while confirming a disable that would affect live sessions (WS11): the runtime being disabled
  // plus its current usage, so the dialog can warn before revoking.
  const [disableImpact, setDisableImpact] = useState<{
    language: NotebookLanguage
    env: DiscoveredInterpreter
    usage: RuntimeUsage
  } | null>(null)
  const dialogDisableImpact = useRetainedDialogValue(disableImpact)
  // The env whose installed-packages dialog is open (null = closed).
  const [packagesEnv, setPackagesEnv] = useState<DiscoveredInterpreter | null>(null)
  const dialogPackagesEnv = useRetainedDialogValue(packagesEnv)
  // The packages dialog is opened from the runtime cards, never from a Dialog.Trigger, and it renders
  // as a sibling of the panel body: the restore has to be explicit for the keyboard user.
  const focusRestore = useDialogFocusRestore(packagesEnv !== null)
  // Dialog content: the fetched list, or a load error with a Retry affordance. retryNonce re-runs
  // the fetch effect without closing/reopening the dialog.
  const [packages, setPackages] = useState<EnvPackage[] | null>(null)
  const [packagesError, setPackagesError] = useState<string | null>(null)
  const [packagesRetryNonce, setPackagesRetryNonce] = useState(0)
  const [packagesFilter, setPackagesFilter] = useState('')
  // Per-env package counts for the card button badges, fetched lazily AFTER the panel loads.
  // countsRef is the source of truth (readable inside effects without re-triggering them); the
  // state mirror drives rendering. A present null entry means "fetch attempted, unavailable" —
  // the card simply omits the badge (a count failure is never surfaced as card-level error UI).
  const countsRef = useRef<Record<string, number | null>>({})
  const [packageCounts, setPackageCounts] = useState<Record<string, number | null>>({})
  // A7 lock import: the language whose dialog is open (null = closed) plus its form/result state. The
  // whole call is one awaited request, so `importing` is the only "running" flag; ticks broadcast by
  // the main process land in the store's dedicated importProgress field (never a runtime card).
  const [importTarget, setImportTarget] = useState<NotebookLanguage | null>(null)
  const dialogImportTarget = useRetainedDialogValue(importTarget)
  const importFocusRestore = useDialogFocusRestore(importTarget !== null)
  const [importName, setImportName] = useState('')
  const [importLock, setImportLock] = useState('')
  const [importAllowDownload, setImportAllowDownload] = useState(true)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportLockResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const importProgress = useNotebookEnvStore((state) => state.importProgress)
  // Audit P0-8: the named environments (the set notebooks select from). An external-lock import used to
  // be a dead end here — no list, no removal, no way to make it a runtime. `namedEnvAction` is the row
  // whose removal is being confirmed.
  const [namedEnvs, setNamedEnvs] = useState<EnvironmentInfo[] | null>(null)
  const [namedEnvAction, setNamedEnvAction] = useState<{ name: string } | null>(null)
  const dialogNamedEnvAction = useRetainedDialogValue(namedEnvAction)
  const initEnv = useNotebookEnvStore((state) => state.init)
  const provisionEnv = useNotebookEnvStore((state) => state.provision)
  const cancelEnv = useNotebookEnvStore((state) => state.cancel)
  const resetEnv = useNotebookEnvStore((state) => state.reset)
  // Per-language provisioning state: python and R each track their own progress/preparing/error, so
  // requesting one never makes the other's card look cancelled (the provisioner serializes the runs).
  const byLang = useNotebookEnvStore((state) => state.byLang)

  useEffect(() => {
    void initEnv()
  }, [initEnv])

  useEffect(() => {
    const getEgress = (
      window.api.settings as { getEgress?: () => Promise<EgressSettings | undefined> }
    )?.getEgress
    if (typeof getEgress !== 'function') return
    let cancelled = false
    void getEgress()
      .then((value) => {
        // Absent persisted settings == the default (protection off), same as the Network panel.
        if (!cancelled) setEgress(value ?? DEFAULT_EGRESS_SETTINGS)
      })
      .catch(() => {
        // Unknown state degrades to "off" rather than surfacing an error in the runtime list.
        if (!cancelled) setEgress(DEFAULT_EGRESS_SETTINGS)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // On failure fall back to empty results (a recoverable "couldn't detect" state with Recheck)
  // rather than hanging on "Detecting…" forever. Loads the discovered envs plus the PERSISTED
  // enablement for both languages so cards show their saved enabled/install-auth state on open.
  const fetchAll = (): Promise<[EnvLists, Enablements, RuntimeSurvey[]]> =>
    Promise.all([
      window.api.runtime.listEnvironments().catch(() => ({ python: [], r: [] }) as EnvLists),
      window.api.runtime.getEnablement('python').catch(() => undefined),
      window.api.runtime.getEnablement('r').catch(() => undefined),
      window.api.runtime.survey().catch(() => [] as RuntimeSurvey[])
    ]).then(([nextEnvs, python, r, nextSurveys]) => [nextEnvs, { python, r }, nextSurveys])

  // Commit discovery and persisted permissions as one snapshot. Mixing a fresh interpreter list
  // with stale enablement could briefly expose the wrong toggle or package-install authorization.
  const applyAll = ([nextEnvs, nextEnablement, nextSurveys]: [
    EnvLists,
    Enablements,
    RuntimeSurvey[]
  ]): void => {
    setEnvs(nextEnvs)
    setEnablement(nextEnablement)
    setSurveys(nextSurveys)
    setLoaded(true)
  }

  useEffect(() => {
    void fetchAll().then(applyAll)
  }, [])

  // Lazy package-count fetch: runs AFTER the env list lands (never blocks fetchAll). One bulk
  // listPackageCounts call per language (the main process does ONE discovery sweep per call and
  // bounds listing concurrency itself), so filling N badges costs 2 IPC calls — not N per-env calls
  // that each re-run full discovery. A failed bulk call (or a null per-env count) simply leaves the
  // badge absent; Recheck clears countsRef so the badges refetch against the new env list.
  useEffect(() => {
    if (envs === null) return
    let cancelled = false
    for (const language of LANGUAGES) {
      // No runnable envs for the language -> nothing to count; skip the IPC call entirely.
      if (!envs[language.id].some((env) => env.runnable)) continue
      void window.api.runtime
        .listPackageCounts(language.id)
        .then((counts) => {
          if (cancelled) return
          Object.assign(countsRef.current, counts)
          setPackageCounts({ ...countsRef.current })
        })
        .catch(() => {
          // Best-effort badges: a bulk failure is not surfaced as card-level error UI.
        })
    }
    return () => {
      cancelled = true
    }
  }, [envs])

  // Fetches the open dialog's package list; re-runs on Retry via packagesRetryNonce. A successful
  // fetch also refreshes the card's count badge (the dialog shows the same truth). The loading/error
  // reset happens in the open/retry click handlers, not synchronously here (react-hooks lint).
  useEffect(() => {
    if (packagesEnv === null) return
    const env = packagesEnv
    let cancelled = false
    window.api.runtime
      .listPackages(env.language, env.envId)
      .then((list) => {
        if (cancelled) return
        setPackages(list)
        countsRef.current[env.envId] = list.length
        setPackageCounts({ ...countsRef.current })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setPackagesError(e instanceof Error ? e.message : t('settings.couldNotListPackages'))
      })
    return () => {
      cancelled = true
    }
  }, [packagesEnv, packagesRetryNonce, t])

  // Recheck refreshes both halves of the runtime registry together for the same reason as initial
  // loading: cards and their permissions must describe one coherent backend snapshot. Counts are
  // cleared too so every badge refetches against the new env list.
  const recheck = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    countsRef.current = {}
    setPackageCounts({})
    try {
      applyAll(await fetchAll())
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.couldNotRecheckRuntimes'))
    } finally {
      setBusy(false)
    }
  }

  const isEnabled = (language: NotebookLanguage, env: DiscoveredInterpreter): boolean =>
    isEnvEnabled(env, enablement[language])

  const isInstallAuthorized = (language: NotebookLanguage, env: DiscoveredInterpreter): boolean =>
    enablement[language]?.installAuthorized[env.envId] ?? false

  const isCurrentRuntime = (language: NotebookLanguage, env: DiscoveredInterpreter): boolean => {
    const selection = surveys.find((survey) => survey.language === language)?.selection
    if (selection === undefined) return false
    if (selection.source === 'managed') return env.provenance === 'app-managed'

    return selection.interpreterPath === env.interpreterPath
  }

  // Which env may be promoted to the language's runtime: the app-managed env always, and — Python
  // only, because R is managed-only by contract — one of the user's own registered interpreters. An
  // agent-created env belongs to the agent's own binding flow, so it is not offered here.
  const canSelectAsRuntime = (language: NotebookLanguage, env: DiscoveredInterpreter): boolean =>
    env.runnable &&
    isEnabled(language, env) &&
    (env.provenance === 'app-managed' || (language === 'python' && env.provenance === 'user-own'))

  const selectAsRuntime = async (
    language: NotebookLanguage,
    env: DiscoveredInterpreter
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const selection: RuntimeSelection =
        env.provenance === 'app-managed'
          ? { source: 'managed' }
          : {
              source: 'external',
              interpreterPath: env.interpreterPath,
              // The launched interpreter's leading args live on the readiness probe, not on the
              // discovered entry, so a launcher-based install is addressed through its path here.
              appOwnedOverlay: false,
              packageInstallAuthorized: isInstallAuthorized(language, env)
            }
      const next = await window.api.runtime.setSelection(language, selection)
      setSurveys((current) => [
        ...current.filter((survey) => survey.language !== next.language),
        next
      ])
      setNotice(t('settings.selectedRuntime').replace('{name}', env.label))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.couldNotSelectRuntime'))
    } finally {
      setBusy(false)
    }
  }

  const unregisterInterpreter = async (
    language: NotebookLanguage,
    env: DiscoveredInterpreter
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await window.api.runtime.unregisterInterpreter(language, env.envId)
      countsRef.current = {}
      setPackageCounts({})
      applyAll(await fetchAll())
      setNotice(t('settings.unregisteredInterpreter').replace('{name}', env.label))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.couldNotUnregisterInterpreter'))
    } finally {
      setBusy(false)
    }
  }

  const applyEnabled = async (
    language: NotebookLanguage,
    env: DiscoveredInterpreter,
    enabled: boolean,
    force?: boolean
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // set-environment-enabled rejects when it would disable the LAST enabled env for a language
      // (the ">= 1 usable" invariant); surface that reason inline instead of silently no-op'ing.
      // force (disable only) aborts a running cell now instead of draining.
      const next = await window.api.runtime.setEnvironmentEnabled(
        language,
        env.envId,
        enabled,
        force
      )
      setEnablement((current) => ({ ...current, [language]: next }))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.couldNotChangeRuntime'))
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (
    language: NotebookLanguage,
    env: DiscoveredInterpreter
  ): Promise<void> => {
    // Enabling never affects live sessions — apply immediately.
    if (!isEnabled(language, env)) {
      await applyEnabled(language, env, true)
      return
    }
    // Disabling: warn first if live sessions are using it. Dormant-only (bound but no live kernel) or
    // no usage disables straight away; running/idle sessions get a confirm dialog (WS11).
    const usage = await window.api.runtime
      .describeUsage(language, env.envId)
      .catch(() => ({ running: 0, idle: 0, dormant: 0 }) as RuntimeUsage)
    if (usage.running + usage.idle > 0) {
      setDisableImpact({ language, env, usage })
      return
    }
    await applyEnabled(language, env, false)
  }

  // Disable after current work finishes (drain) — the default, safe option.
  const confirmDisable = async (): Promise<void> => {
    if (!disableImpact) return
    const { language, env } = disableImpact
    setDisableImpact(null)
    await applyEnabled(language, env, false)
  }

  // Stop running work and disable now (force) — aborts a running cell (recorded cancelled).
  const confirmForceStop = async (): Promise<void> => {
    if (!disableImpact) return
    const { language, env } = disableImpact
    setDisableImpact(null)
    await applyEnabled(language, env, false, true)
  }

  const toggleInstallAuthorized = async (
    language: NotebookLanguage,
    env: DiscoveredInterpreter
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.runtime.setInstallAuthorized(
        language,
        env.envId,
        !isInstallAuthorized(language, env)
      )
      setEnablement((current) => ({ ...current, [language]: next }))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.couldNotChangePackageAuth'))
    } finally {
      setBusy(false)
    }
  }

  const addInterpreter = async (language: NotebookLanguage): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const path = await window.api.runtime.pickInterpreter()
      if (!path) return
      // Add the picked path to the discovery catalog; it then surfaces as a (user-own) card once
      // discovery probes it. It starts DISABLED (user-own default) — the user enables it explicitly.
      await window.api.runtime.registerInterpreter(language, path)
      const nextEnvs = await window.api.runtime.listEnvironments()
      setEnvs(nextEnvs)
      // Best-effort: enable the just-added env so it is usable immediately.
      const added = nextEnvs[language].find((env) => env.interpreterPath === path)
      if (added && !isEnvEnabled(added, enablement[language])) {
        const next = await window.api.runtime.setEnvironmentEnabled(language, added.envId, true)
        setEnablement((current) => ({ ...current, [language]: next }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.couldNotAddInterpreter'))
    } finally {
      setBusy(false)
    }
  }

  const provisionManaged = async (language: NotebookLanguage): Promise<void> => {
    // Provisioning deliberately avoids the panel-wide busy flag. Per-language store state marks only
    // the active runtime as preparing and leaves its Cancel action available throughout the download.
    setManagedOperations((current) => ({ ...current, [language]: true }))
    setError(null)
    try {
      await provisionEnv(language)
      // The provisioner updates files and registry metadata in the main process; reload both the
      // discovered environments and persisted enablement before rendering the completed card.
      applyAll(await fetchAll())
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.couldNotRefreshRuntimeReadiness'))
    } finally {
      setManagedOperations((current) => ({ ...current, [language]: false }))
    }
  }

  // Explicit recovery for a recovery-BLOCKED runtime (a prior setup's worker couldn't be confirmed
  // stopped, so plain provision keeps refusing). Reset force-clears the quarantine and rebuilds.
  const resetManaged = async (language: NotebookLanguage): Promise<void> => {
    setManagedOperations((current) => ({ ...current, [language]: true }))
    setError(null)
    try {
      await resetEnv(language)
      applyAll(await fetchAll())
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.couldNotResetRuntime'))
    } finally {
      setManagedOperations((current) => ({ ...current, [language]: false }))
    }
  }

  // Cancels an in-flight app-managed download/setup so it is never a locked, un-abortable state.
  const cancelProvision = async (language: NotebookLanguage): Promise<void> => {
    setError(null)
    try {
      await cancelEnv(language)
      applyAll(await fetchAll())
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.couldNotCancelSetup'))
    }
  }

  // Opens the A7 import dialog for one language with a clean form and no stale progress/result.
  const openImportLock = (language: NotebookLanguage): void => {
    useNotebookEnvStore.setState({ importProgress: undefined })
    setImportName('')
    setImportLock('')
    setImportAllowDownload(true)
    setImportResult(null)
    setImportError(null)
    setImportTarget(language)
  }

  // A7: one awaited import. Fail-closed verification lives in the main process; here we surface the
  // discriminated result (imported vs incomplete + the named per-entry reasons) and refresh the cards
  // so a successfully created environment shows up immediately.
  const runImportLock = async (): Promise<void> => {
    if (importTarget === null) return
    if (importLock.trim() === '') {
      setImportError(t('runtimes.importLockEmpty'))
      return
    }
    const language = importTarget
    setImporting(true)
    setImportError(null)
    setImportResult(null)
    try {
      const result = await window.api.runtime.importLock({
        language,
        name: importName.trim(),
        lock: importLock,
        allowDownload: importAllowDownload
      })
      setImportResult(result)
      if (result.status === 'imported') {
        countsRef.current = {}
        setPackageCounts({})
        applyAll(await fetchAll())
        setNotice(importImportedLine(t, result.environment.name, result.coverage))
        // The import just created a named env, so the list must show it without a reload.
        void refreshNamedEnvs()
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setImportError(t('runtimes.importLockFailed').replace('{message}', message))
    } finally {
      setImporting(false)
    }
  }

  // Lists the named environments. A failure leaves an empty list rather than hanging on "Detecting…",
  // and surfaces the reason through the panel's own error line. Memoised because the mount effect below
  // must be able to name it as a dependency instead of closing over a fresh identity every render.
  const refreshNamedEnvs = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.runtime.manageNamedEnvironments({ action: 'list' })
      setNamedEnvs(result.environments)
    } catch (e) {
      setNamedEnvs([])
      setError(e instanceof Error ? e.message : t('runtimes.namedEnvsEmpty'))
    }
  }, [t])

  useEffect(() => {
    void refreshNamedEnvs()
  }, [refreshNamedEnvs])

  // Removal is the service's call: it refuses while a live kernel uses the env, and that reason is shown
  // verbatim (never reworded into something friendlier).
  const confirmRemoveNamedEnv = async (): Promise<void> => {
    if (namedEnvAction === null) return
    const { name } = namedEnvAction
    setNamedEnvAction(null)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.api.runtime.manageNamedEnvironments({ action: 'remove', name })
      setNamedEnvs(result.environments)
      setNotice(t('runtimes.namedEnvRemoved').replace('{name}', name))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Promotes a named env through the EXISTING selection channels (register → enable → select), so no new
  // backend surface is needed to make an imported environment usable as a runtime.
  // NOT a hook, despite what the old name implied: this is a plain handler, so it must NOT be called
  // `useX` — the linter (rightly) reads that prefix as a hook and rejects calling it from a callback.
  const applyNamedEnvAsRuntime = async (env: EnvironmentInfo): Promise<void> => {
    if (env.language !== 'python' || env.interpreterPath === undefined) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await window.api.runtime.registerInterpreter(env.language, env.interpreterPath)
      let next = await window.api.runtime.listEnvironments()
      const added = next.python.find(
        (candidate) => candidate.interpreterPath === env.interpreterPath
      )
      if (added && !isEnvEnabled(added, enablement.python)) {
        const updated = await window.api.runtime.setEnvironmentEnabled('python', added.envId, true)
        setEnablement((current) => ({ ...current, python: updated }))
        next = await window.api.runtime.listEnvironments()
      }
      const selected =
        next.python.find((candidate) => candidate.interpreterPath === env.interpreterPath) ?? added
      if (selected) {
        const survey = await window.api.runtime.setSelection('python', {
          source: 'external',
          interpreterPath: env.interpreterPath,
          appOwnedOverlay: false,
          packageInstallAuthorized: isInstallAuthorized('python', selected)
        })
        setSurveys((current) => [
          ...current.filter((entry) => entry.language !== survey.language),
          survey
        ])
      }
      applyAll(await fetchAll())
      setNotice(t('runtimes.namedEnvUsed').replace('{name}', env.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Managed readiness is derived from discovery: the app-managed env for a language is present and
  // runnable once it is set up (replaces the old survey().managed readiness).
  const managedRunnableFor = (language: NotebookLanguage): boolean =>
    (envs?.[language] ?? []).some((env) => env.provenance === 'app-managed' && env.runnable)

  // One environment card (detected app-managed or user-own): identity + readiness + enable toggle,
  // plus the install-authorization row for an enabled external env. Shared by the managed-first card
  // and each own interpreter so they render identically.
  // A catalogued path that the system also discovers ('both') survives unregistering, so the control is
  // offered only for a path the catalog alone knows about.
  const canUnregister = (env: DiscoveredInterpreter): boolean => env.registration === 'catalog'

  const renderEnvCard = (
    language: NotebookLanguage,
    env: DiscoveredInterpreter
  ): React.JSX.Element => {
    const enabled = isEnabled(language, env)
    const external = env.provenance !== 'app-managed'
    return (
      <div
        key={env.envId}
        data-testid="runtime-card"
        className="rounded-lg border border-border bg-card p-3"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{env.label}</span>
              <Badge variant="secondary">{providerType(env, t)}</Badge>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[13px] text-muted-foreground">
              {env.runnable ? (
                <CheckCircle2 className="size-3.5 text-primary" aria-hidden="true" />
              ) : null}
              <span>{envReadyLine(env, t)}</span>
            </div>
            <code className="mt-1 block truncate text-xs text-muted-foreground">
              {env.interpreterPath}
            </code>
          </div>
          <SettingsToggle
            enabled={enabled}
            onToggle={() => void toggleEnabled(language, env)}
            disabled={busy}
            aria-label={`Enable ${env.label}`}
          />
        </div>

        {isCurrentRuntime(language, env) ||
        canSelectAsRuntime(language, env) ||
        canUnregister(env) ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {isCurrentRuntime(language, env) ? (
              <Badge variant="secondary" data-testid="runtime-current">
                <CheckCircle2 aria-hidden="true" /> {t('settings.currentRuntime')}
              </Badge>
            ) : canSelectAsRuntime(language, env) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="runtime-use-for-notebooks"
                disabled={busy}
                onClick={() => void selectAsRuntime(language, env)}
              >
                <CheckCircle2 aria-hidden="true" /> {t('settings.useForNotebooks')}
              </Button>
            ) : null}
            {env.provenance === 'user-own' ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="runtime-unregister"
                disabled={busy}
                onClick={() => void unregisterInterpreter(language, env)}
              >
                <Trash2 aria-hidden="true" />
                {t('settings.unregisterInterpreter').replace('{name}', env.label)}
              </Button>
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              {t('settings.runtimeSelectionHint')}
            </span>
          </div>
        ) : null}

        {env.runnable ? (
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="runtime-packages-button"
              onClick={() => {
                setPackages(null)
                setPackagesError(null)
                setPackagesFilter('')
                setPackagesEnv(env)
              }}
            >
              <Package aria-hidden="true" />
              Packages
              {typeof packageCounts[env.envId] === 'number' ? (
                <Badge variant="secondary" data-testid="runtime-packages-count">
                  {packageCounts[env.envId]}
                </Badge>
              ) : null}
            </Button>
          </div>
        ) : null}

        {external && enabled ? (
          <div className="mt-3 border-t border-border pt-3">
            <SettingsRow
              className="min-h-0 py-0"
              label={t('settings.allowPackageInstall')}
              description={t('settings.allowPackageInstallDesc')}
            >
              <div className="flex justify-end">
                <SettingsToggle
                  enabled={isInstallAuthorized(language, env)}
                  onToggle={() => void toggleInstallAuthorized(language, env)}
                  disabled={busy}
                  aria-label={t('settings.allowPackageInstallFor').replace('{name}', env.label)}
                />
              </div>
            </SettingsRow>
          </div>
        ) : null}
      </div>
    )
  }

  const loading = !loaded || envs === null

  // Dialog table derivations. Build/Channel columns appear only for conda-style listings (any
  // package carrying build/channel); pip/CRAN listings get just Name/Version.
  const visiblePackages = (packages ?? []).filter((pkg) =>
    pkg.name.toLowerCase().includes(packagesFilter.trim().toLowerCase())
  )
  const hasCondaFields = (packages ?? []).some(
    (pkg) => pkg.build !== undefined || pkg.channel !== undefined
  )
  const condaPackageCount = (packages ?? []).filter(
    (pkg) => pkg.build !== undefined || pkg.channel !== undefined
  ).length

  return (
    <div className="p-5" data-testid="runtimes-panel">
      <SettingsSection
        title={title}
        description={description}
        aria-label={title}
        contentClassName="space-y-5"
        actionClassName="ml-auto"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void recheck()}
            disabled={busy}
          >
            <RefreshCw className={cn(busy && 'animate-spin')} aria-hidden="true" />
            {t('settings.recheck')}
          </Button>
        }
      >
        {egress !== undefined ? (
          <div
            data-testid="runtimes-egress-card"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-3 py-2.5"
          >
            {egress.enabled ? (
              <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <ShieldOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <p className="min-w-0 flex-1 text-[13px] text-foreground">
              {egress.enabled ? t('settings.egressStatusActive') : t('settings.egressStatusOff')}
            </p>
            {!egress.enabled && onOpenNetwork ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="runtimes-egress-open-network"
                onClick={onOpenNetwork}
              >
                {t('settings.egressStatusOpen')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="runtimes-error">
            {error}
          </p>
        )}
        {notice !== null && (
          <p role="status" className="text-sm text-primary" data-testid="runtimes-notice">
            {notice}
          </p>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('settings.detectingRuntimes')}</p>
        ) : (
          LANGUAGES.map(({ id, label, icon }) => {
            const list = envs[id]
            // Per-language provisioning state — set immediately on click and cleared when THIS language's
            // run settles, independent of the other language (fixes the concurrent python/R phantom-cancel).
            const langState = byLang[id]
            const preparing = langState?.preparing ?? false
            const finishing = managedOperations[id] === true && !preparing
            const settingUp = preparing || finishing
            const langProgress = langState?.progress
            const progress = finishing ? 1 : (langProgress?.progress ?? 0)
            const langError = langState?.error
            const managedRunnable = managedRunnableFor(id)

            // App-managed goes FIRST; the user's own detected interpreters follow. A provisioned
            // app-managed env appears in `list` (provenance app-managed) and renders as a normal card;
            // when it isn't set up yet there is no such entry, so a setup card is shown in its place.
            const managedEnv = list.find((env) => env.provenance === 'app-managed')
            const ownEnvs = list.filter((env) => env.provenance !== 'app-managed')

            return (
              <SettingsSection
                key={id}
                title={label}
                icon={icon}
                aria-label={`${label} runtime`}
                separated
                action={
                  <div className="flex items-center gap-2">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void addInterpreter(id)}
                          >
                            <FolderInput aria-hidden="true" />
                            {t('settings.addInterpreter')}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          {id === 'r'
                            ? t('settings.pickRscriptExecutable')
                            : t('settings.pickPythonExecutable')}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    {/* A7: materialize a named env from an external @EXPLICIT lock. */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      data-testid={`runtime-import-lock-${id}`}
                      onClick={() => openImportLock(id)}
                    >
                      <Upload aria-hidden="true" />
                      {t('runtimes.importLock')}
                    </Button>
                  </div>
                }
              >
                <div className="space-y-2" data-testid={`runtimes-cards-${id}`}>
                  {/* App-managed FIRST: a real card once provisioned, else a setup card in the same frame. */}
                  {managedEnv ? (
                    <>
                      {renderEnvCard(id, managedEnv)}
                      {/* An interrupted upgrade/install usually leaves the interpreter present (so the
                        card above still renders), but recovery may have quarantined its prefix. Surface
                        the block + Reset here too, or the recovery entry would be unreachable whenever a
                        runnable managed env exists. */}
                      {!settingUp && langError?.includes('RUNTIME_RECOVERY_BLOCKED') ? (
                        <div
                          data-testid={`runtimes-recovery-blocked-${id}`}
                          className="flex items-start justify-between gap-4 rounded-lg border border-destructive/40 bg-card p-3"
                        >
                          <p
                            role="alert"
                            className="text-[13px] text-destructive"
                            data-testid={`runtimes-provision-error-${id}`}
                          >
                            {langError}
                          </p>
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            className="shrink-0"
                            disabled={busy}
                            onClick={() => void resetManaged(id)}
                          >
                            {t('runtimes.reset')}
                          </Button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div
                      data-testid="runtime-card"
                      className="rounded-lg border border-border bg-card p-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              {t('runtimes.appManagedEnv')}
                            </span>
                            <Badge variant="secondary">{t('settings.appManaged')}</Badge>
                          </div>
                          <div className="mt-0.5 text-[13px] text-muted-foreground">
                            {managedLine(
                              managedRunnable,
                              settingUp,
                              t,
                              finishing ? t('settings.finishingSetup') : langProgress?.message
                            )}
                          </div>
                          {settingUp ? (
                            <div
                              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                              role="progressbar"
                              aria-label={`Setting up ${label} runtime`}
                              aria-valuenow={Math.round(progress * 100)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              <div
                                className="h-full rounded-full bg-primary transition-[width] duration-300"
                                style={{
                                  width: `${Math.max(2, Math.min(100, Math.round(progress * 100)))}%`
                                }}
                              />
                            </div>
                          ) : null}
                          {!settingUp && langError ? (
                            <p
                              role="alert"
                              className="mt-1 text-[13px] text-destructive"
                              data-testid={`runtimes-provision-error-${id}`}
                            >
                              {langError}
                            </p>
                          ) : null}
                        </div>
                        {preparing ? (
                          // A download/setup in progress is cancelable — never a locked, un-abortable state.
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled={busy}
                            onClick={() => void cancelProvision(id)}
                          >
                            Cancel
                          </Button>
                        ) : finishing ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled
                          >
                            Finishing setup…
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            className="shrink-0"
                            disabled={busy}
                            onClick={() =>
                              langError?.includes('RUNTIME_RECOVERY_BLOCKED')
                                ? void resetManaged(id)
                                : void provisionManaged(id)
                            }
                          >
                            {langError?.includes('RUNTIME_RECOVERY_BLOCKED')
                              ? t('settings.resetRuntime')
                              : langError
                                ? t('settings.retrySetup')
                                : t('settings.downloadAndSetUp')}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}

                  {ownEnvs.map((env) => renderEnvCard(id, env))}
                </div>
              </SettingsSection>
            )
          })
        )}
      </SettingsSection>

      {/* Audit P0-8: the named environments — the surface an external-lock import used to be a dead end
          without (no list, no removal, no way to make it a runtime). */}
      <SettingsSection
        title={t('runtimes.namedEnvs')}
        description={t('runtimes.namedEnvsDesc')}
        aria-label={t('runtimes.namedEnvs')}
        separated
      >
        <div className="space-y-2" data-testid="runtimes-named-envs">
          {namedEnvs === null ? (
            <p className="text-sm text-muted-foreground">{t('settings.detectingRuntimes')}</p>
          ) : namedEnvs.length === 0 ? (
            <p
              className="text-[13px] text-muted-foreground"
              data-testid="runtimes-named-envs-empty"
            >
              {t('runtimes.namedEnvsEmpty')}
            </p>
          ) : (
            namedEnvs.map((env) => (
              <div
                key={env.name}
                data-testid="named-env-row"
                className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{env.name}</span>
                    <Badge variant="secondary">{env.language}</Badge>
                    <Badge variant={env.ready ? 'secondary' : 'destructive'}>
                      {env.ready ? t('settings.ready') : t('settings.notRunnable')}
                    </Badge>
                  </div>
                  {env.interpreterPath ? (
                    <code className="mt-1 block truncate text-xs text-muted-foreground">
                      {env.interpreterPath}
                    </code>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {env.language === 'python' && env.interpreterPath ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="named-env-use"
                      disabled={busy}
                      onClick={() => void applyNamedEnvAsRuntime(env)}
                    >
                      <CheckCircle2 aria-hidden="true" /> {t('runtimes.useNamedEnv')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="named-env-remove"
                    disabled={busy}
                    onClick={() => setNamedEnvAction({ name: env.name })}
                  >
                    <Trash2 aria-hidden="true" /> {t('runtimes.removeNamedEnv')}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsSection>

      <AlertDialog.Root
        open={namedEnvAction !== null}
        onOpenChange={(open) => {
          if (!open) setNamedEnvAction(null)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            data-testid="named-env-remove-dialog"
            className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}
          >
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('runtimes.removeNamedEnvTitle').replace(
                '{name}',
                dialogNamedEnvAction?.name ?? ''
              )}
            </AlertDialog.Title>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {t('runtimes.namedEnvsDesc')}
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  {t('common.cancel')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  variant="destructive"
                  data-testid="named-env-remove-confirm"
                  onClick={() => void confirmRemoveNamedEnv()}
                >
                  {t('runtimes.removeNamedEnv')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root
        open={disableImpact !== null}
        onOpenChange={(open) => {
          if (!open) setDisableImpact(null)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            data-testid="disable-impact-dialog"
            className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}
          >
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('runtimes.disableTitle').replace('{env}', dialogDisableImpact?.env.label ?? '')}
            </AlertDialog.Title>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {describeDisableImpact(t as (key: string) => string, dialogDisableImpact?.usage)}
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  {t('common.cancel')}
                </Button>
              </AlertDialog.Cancel>
              {(dialogDisableImpact?.usage.running ?? 0) > 0 ? (
                <AlertDialog.Action asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void confirmForceStop()}
                  >
                    {t('runtimes.stopRunningWork')}
                  </Button>
                </AlertDialog.Action>
              ) : null}
              <AlertDialog.Action asChild>
                <Button type="button" onClick={() => void confirmDisable()}>
                  {t('runtimes.disableAfterCurrentWork')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <Dialog.Root
        open={packagesEnv !== null}
        onOpenChange={(open) => {
          if (!open) setPackagesEnv(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            onOpenAutoFocus={focusRestore.onOpenAutoFocus}
            onCloseAutoFocus={focusRestore.onCloseAutoFocus}
            data-testid="runtime-packages-dialog"
            className={dialogPanelClassName(
              'flex max-h-[85vh] w-[min(760px,calc(100vw-2rem))] flex-col'
            )}
          >
            {dialogPackagesEnv ? (
              <>
                <Dialog.Title className={dialogTitleClassName}>
                  {t('settings.packagesIn').replace('{name}', dialogPackagesEnv.label)}
                  {dialogPackagesEnv.version ? ` · ${dialogPackagesEnv.version}` : ''}
                </Dialog.Title>
                <Dialog.Description className={dialogDescriptionClassName}>
                  {t('runtimes.installedPackages')}.
                </Dialog.Description>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                  <Badge variant="secondary">{providerType(dialogPackagesEnv, t)}</Badge>
                  {/* Conda env name badge — but only when the provenance badge doesn't already carry
                      it: providerType() returns `Conda: <name>` for user-own conda envs, so the name
                      badge is added just for app-owned (app-managed/agent-created) conda envs. */}
                  {dialogPackagesEnv.condaEnv &&
                  providerType(dialogPackagesEnv, t) !==
                    `${t('settings.conda')}: ${dialogPackagesEnv.condaEnv}` ? (
                    <Badge variant="secondary">
                      {t('settings.conda')}: {dialogPackagesEnv.condaEnv}
                    </Badge>
                  ) : null}
                  <Badge variant={dialogPackagesEnv.runnable ? 'secondary' : 'destructive'}>
                    {dialogPackagesEnv.runnable ? t('settings.ready') : t('settings.notRunnable')}
                  </Badge>
                  <code className="truncate text-xs">{dialogPackagesEnv.interpreterPath}</code>
                </div>

                <div className="mt-3 flex items-center gap-3">
                  <div className="relative max-w-sm flex-1">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      value={packagesFilter}
                      onChange={(event) => setPackagesFilter(event.target.value)}
                      placeholder={t('settings.filterPackagesPlaceholder')}
                      aria-label={t('settings.filterPackages')}
                      data-testid="runtime-packages-filter"
                      className="pl-8"
                    />
                  </div>
                  {packages !== null ? (
                    <span className="text-xs text-muted-foreground">
                      {visiblePackages.length} of {packages.length}
                      {hasCondaFields
                        ? ` · ${condaPackageCount} conda, ${packages.length - condaPackageCount} pypi`
                        : ''}
                    </span>
                  ) : null}
                </div>

                <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
                  {packagesError !== null ? (
                    <div className="flex flex-col items-center gap-2 px-3 py-6">
                      <p role="alert" className="text-sm text-destructive">
                        {packagesError}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPackages(null)
                          setPackagesError(null)
                          setPackagesRetryNonce((nonce) => nonce + 1)
                        }}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : packages === null ? (
                    <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                      Listing packages…
                    </p>
                  ) : (
                    <table className="w-full border-collapse text-[13px]">
                      <thead className="sticky top-0 bg-card">
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 pl-3 pr-3 font-medium">{t('settings.name')}</th>
                          <th className="py-2 pr-3 font-medium">{t('settings.version')}</th>
                          {hasCondaFields ? (
                            <>
                              <th className="py-2 pr-3 font-medium">{t('settings.build')}</th>
                              <th className="py-2 pr-3 font-medium">{t('settings.channel')}</th>
                            </>
                          ) : null}
                        </tr>
                      </thead>
                      <tbody>
                        {visiblePackages.map((pkg) => (
                          <tr
                            key={pkg.name}
                            data-testid="runtime-package-row"
                            className="border-b border-border last:border-b-0"
                          >
                            <td className="py-1.5 pl-3 pr-3 text-foreground">{pkg.name}</td>
                            <td className="py-1.5 pr-3">
                              <code className="text-xs text-muted-foreground">{pkg.version}</code>
                            </td>
                            {hasCondaFields ? (
                              <>
                                <td className="py-1.5 pr-3">
                                  <code className="text-xs text-muted-foreground">
                                    {pkg.build ?? '—'}
                                  </code>
                                </td>
                                <td className="py-1.5 pr-3 text-xs text-muted-foreground">
                                  {pkg.channel ?? '—'}
                                </td>
                              </>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {packages !== null &&
                  packagesError === null &&
                  packages.length > 0 &&
                  visiblePackages.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                      No packages match “{packagesFilter}”.
                    </p>
                  ) : null}
                  {packages !== null && packagesError === null && packages.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {t('runtimes.noPackages')}.
                    </p>
                  ) : null}
                </div>

                <div className="mt-4 flex justify-end">
                  <Dialog.Close asChild>
                    <Button type="button" variant="outline" size="sm">
                      Close
                    </Button>
                  </Dialog.Close>
                </div>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* A7: import a named environment from an external @EXPLICIT lock. Fail-closed in the main
          process — an incomplete import reports every unsatisfied entry and creates nothing. */}
      <Dialog.Root
        open={importTarget !== null}
        onOpenChange={(open) => {
          if (!open && !importing) setImportTarget(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            onOpenAutoFocus={importFocusRestore.onOpenAutoFocus}
            onCloseAutoFocus={importFocusRestore.onCloseAutoFocus}
            data-testid="runtime-import-dialog"
            className={dialogPanelClassName(
              'flex max-h-[85vh] w-[min(620px,calc(100vw-2rem))] flex-col'
            )}
          >
            {dialogImportTarget ? (
              <>
                <Dialog.Title className={dialogTitleClassName}>
                  {t('runtimes.importLockTitle')}
                </Dialog.Title>
                <Dialog.Description className={dialogDescriptionClassName}>
                  {t('runtimes.importLockDesc')}
                </Dialog.Description>

                {/* A lock body is long (a real one ran to tens of lines): the middle scrolls and the
                    footer stays put, so Import/Cancel remain reachable on a short window. A real-window
                    run caught the button being pushed outside the viewport with no way to reach it. */}
                <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  <div className="space-y-1">
                    <label
                      className="text-[13px] font-medium text-foreground"
                      htmlFor="runtime-import-name"
                    >
                      {t('runtimes.importLockName')}
                    </label>
                    <Input
                      id="runtime-import-name"
                      data-testid="runtime-import-name"
                      value={importName}
                      onChange={(event) => setImportName(event.target.value)}
                      disabled={importing}
                      placeholder={dialogImportTarget === 'r' ? 'r-lock-env' : 'lock-env'}
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      className="text-[13px] font-medium text-foreground"
                      htmlFor="runtime-import-lock"
                    >
                      {t('runtimes.importLockContents')}
                    </label>
                    <Textarea
                      id="runtime-import-lock"
                      data-testid="runtime-import-lock"
                      value={importLock}
                      onChange={(event) => setImportLock(event.target.value)}
                      disabled={importing}
                      rows={8}
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                  </div>

                  <div className="flex items-start gap-3">
                    <SettingsToggle
                      enabled={importAllowDownload}
                      onToggle={() => setImportAllowDownload((value) => !value)}
                      disabled={importing}
                      aria-label={t('runtimes.importLockAllowDownload')}
                    />
                    <div className="min-w-0">
                      <p className="text-[13px] text-foreground">
                        {t('runtimes.importLockAllowDownload')}
                      </p>
                      <p className="text-[12px] text-muted-foreground">
                        {t('runtimes.importLockAllowDownloadDesc')}
                      </p>
                    </div>
                  </div>

                  {importing ? (
                    importProgress ? (
                      <div className="mt-3" data-testid="runtime-import-progress">
                        <div
                          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                          role="progressbar"
                          aria-label={t('runtimes.importLockBusy')}
                          aria-valuenow={Math.round(importProgress.progress * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-[width] duration-300"
                            style={{
                              width: `${Math.max(2, Math.min(100, Math.round(importProgress.progress * 100)))}%`
                            }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {importProgress.message}
                        </p>
                      </div>
                    ) : (
                      <p
                        className="mt-3 text-[13px] text-muted-foreground"
                        data-testid="runtime-import-busy"
                      >
                        {t('runtimes.importLockBusy')}
                      </p>
                    )
                  ) : null}

                  {importError !== null ? (
                    <p
                      role="alert"
                      className="mt-3 text-[13px] text-destructive"
                      data-testid="runtime-import-error"
                    >
                      {importError}
                    </p>
                  ) : null}

                  {importResult !== null ? (
                    <div
                      className="mt-3 rounded-md border border-border p-3"
                      data-testid="runtime-import-result"
                    >
                      <p
                        className={cn(
                          'text-[13px]',
                          importResult.status === 'imported' ? 'text-primary' : 'text-destructive'
                        )}
                        data-testid="runtime-import-status"
                      >
                        {importResult.status === 'imported'
                          ? importImportedLine(
                              t,
                              importResult.environment.name,
                              importResult.coverage
                            )
                          : importIncompleteLine(t, importResult.coverage)}
                      </p>
                      {importResult.coverage.missing.length > 0 ? (
                        <ul
                          className="mt-1 max-h-40 space-y-0.5 overflow-y-auto"
                          data-testid="runtime-import-missing"
                        >
                          {importResult.coverage.missing.map((entry) => (
                            <li
                              key={entry.file}
                              className="text-[12px] text-muted-foreground"
                              data-testid="runtime-import-missing-entry"
                            >
                              <code className="text-xs">{entry.file}</code> — {entry.reason}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="mt-4 flex justify-end gap-2">
                  <Dialog.Close asChild>
                    <Button type="button" variant="outline" size="sm" disabled={importing}>
                      {t('common.cancel')}
                    </Button>
                  </Dialog.Close>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    data-testid="runtime-import-submit"
                    disabled={importing || importName.trim() === '' || importLock.trim() === ''}
                    onClick={() => void runImportLock()}
                  >
                    {importing ? t('runtimes.importLockBusy') : t('runtimes.importLockAction')}
                  </Button>
                </div>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

export { RuntimesPanel }
