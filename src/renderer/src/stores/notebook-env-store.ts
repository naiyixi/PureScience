import { create } from 'zustand'

import type { NotebookLanguage } from '../../../shared/notebook'
import type {
  ProvisionProgress,
  ProvisionScope,
  ProvisionStatus
} from '../../../shared/notebook-env'
import { deriveProvisionUi, type ProvisionUiState } from '../pages/workspace/provisioning-view'

// Per-language provisioning state, tracked ALONGSIDE the single-slot fields below. The provisioner
// serializes python and R, but each has its own progress/preparing/error here so the Settings Runtimes
// panel can render both cards independently — requesting one must never make the other look cancelled.
export type LangProvisionState = {
  progress?: ProvisionProgress
  error?: string
  preparing: boolean
}

export type NotebookEnvState = {
  status: ProvisionStatus
  progress?: ProvisionProgress
  error?: string
  // Last explicit provision request; used when an older progress sender omits its operation scope.
  scope?: ProvisionScope
  // Derived view state (contract §4 UI): recomputed from status/scope/progress/error on every update.
  ui: ProvisionUiState
  // Per-language tracking for the Settings panel (see LangProvisionState); the single-slot fields above
  // still drive the python-centric onboarding/launch/gate surfaces unchanged.
  byLang: Partial<Record<NotebookLanguage, LangProvisionState>>
}

type NotebookEnvStore = NotebookEnvState & {
  init: () => Promise<void>
  provision: (lang: NotebookLanguage) => Promise<void>
  cancel: (lang: NotebookLanguage) => Promise<void>
  retry: () => Promise<void>
  // Explicit recovery for a recovery-BLOCKED runtime (repair force-clears the quarantine + rebuilds).
  reset: (lang: NotebookLanguage) => Promise<void>
}

// Base status plus the ui the reducer derives from it, shared by the initial store state and tests.
// Explicitly nulls the optional fields so a test's merge-based `setState(createInitialNotebookEnvState())`
// reset actually clears any `progress`/`error`/`scope` left over from a prior assertion.
export const createInitialNotebookEnvState = (): NotebookEnvState => {
  const status: ProvisionStatus = {
    pythonReady: false,
    rReady: false,
    version: 0,
    provisioning: false
  }
  return {
    status,
    progress: undefined,
    error: undefined,
    scope: undefined,
    ui: deriveProvisionUi(status, undefined, undefined, undefined),
    byLang: {}
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Writes here are identity-stable, and that is load-bearing. The progress handler re-reads the
// authoritative status on every broadcast, so an update that changes nothing must not hand consumers a
// new state object: useSyncExternalStore treats a fresh object as a real change, re-renders, and the
// re-read writes again — a loop bounded only by how fast the bridge answers. On the packaged app the
// bridge is fastest, which is where it trips React's update-depth guard (error #185).
// One level is enough: the fields this store exposes are primitives (status) or flat view objects (ui).
const sameShallow = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(left[key], right[key]))
  )
}

// The langError the Settings panel keys off to show "Reset runtime". Recovery blocks a prefix in the
// main process WITHOUT touching the ready marker, so status may still report ready — this message,
// derived from ProvisionStatus.*RecoveryBlocked, is what makes the Reset affordance reachable in the UI.
const RECOVERY_BLOCKED_MESSAGE =
  'RUNTIME_RECOVERY_BLOCKED: a previous setup was interrupted and its worker could not be confirmed ' +
  'stopped. Reset this runtime to recover it.'

// Tracks which `window.api.notebookEnv` bridge instances already have a live `onProgress`
// subscription, so a second `init()` call (App.tsx at launch + OnboardingWizard during onboarding,
// or a remount) never stacks a duplicate permanent listener. Keyed by object identity rather than
// store state so it naturally scopes to "this bridge instance" — the real bridge is a singleton for
// the renderer's lifetime, while tests install a fresh mock bridge per case and get a clean slate.
const subscribedBridges = new WeakSet<object>()

export const useNotebookEnvStore = create<NotebookEnvStore>((set, get) => {
  type ExplicitRun = { operationId: string; startProgressRevision: number }
  type ProgressCursor = { revision: number; operationId?: string; terminal: boolean }
  const latestProgress = new Map<NotebookLanguage, ProgressCursor>()
  const explicitRuns = new Map<NotebookLanguage, ExplicitRun[]>()
  const localOperationIds = new Map<NotebookLanguage, Set<string>>()
  const beginExplicitRun = (language: NotebookLanguage): ExplicitRun => {
    const run = {
      operationId: crypto.randomUUID(),
      startProgressRevision: latestProgress.get(language)?.revision ?? 0
    }
    explicitRuns.set(language, [...(explicitRuns.get(language) ?? []), run])
    const operationIds = localOperationIds.get(language) ?? new Set<string>()
    operationIds.add(run.operationId)
    localOperationIds.set(language, operationIds)
    return run
  }
  const trackLanguageProgress = (
    language: NotebookLanguage,
    operationId: string | undefined,
    terminal: boolean
  ): void => {
    latestProgress.set(language, {
      revision: (latestProgress.get(language)?.revision ?? 0) + 1,
      operationId,
      terminal
    })
  }
  const endExplicitRun = (
    language: NotebookLanguage,
    run: ExplicitRun
  ): { last: boolean; ownsLatestProgress: boolean; newerProgressTerminal: boolean } => {
    const remaining = (explicitRuns.get(language) ?? []).filter((candidate) => candidate !== run)
    if (remaining.length > 0) explicitRuns.set(language, remaining)
    else explicitRuns.delete(language)
    const latest = latestProgress.get(language)
    const completion = {
      last: remaining.length === 0,
      newerProgressTerminal:
        latest?.terminal === true && latest.revision > run.startProgressRevision,
      // An unchanged cursor or another locally queued explicit operation owns the visible state once
      // this renderer's queue drains. Newer automatic or another window's progress must survive.
      ownsLatestProgress:
        !latest ||
        latest.revision === run.startProgressRevision ||
        latest.operationId === run.operationId ||
        (latest.operationId !== undefined &&
          (localOperationIds.get(language)?.has(latest.operationId) ?? false))
    }
    if (completion.last) localOperationIds.delete(language)
    return completion
  }

  // Merges a partial update into state, then re-derives `ui` from the resulting status/scope/
  // progress/error so every consumer of `ui` (onboarding step, launch banner, notebook gate) sees a
  // view that always matches the latest mirrored state (reuses provisioning-view's pure reducer).
  // A partial that changes nothing returns the current state untouched, so no consumer is notified.
  const applyUi = (partial: Partial<NotebookEnvState>): void => {
    set((s) => {
      const next = { ...s, ...partial }
      const ui = deriveProvisionUi(next.status, next.scope, next.progress, next.error)
      const unchanged =
        Object.keys(partial).every((key) =>
          sameShallow(
            (s as Record<string, unknown>)[key],
            (partial as Record<string, unknown>)[key]
          )
        ) && sameShallow(s.ui, ui)
      if (unchanged) return s
      return {
        ...partial,
        ui
      }
    })
  }

  // Merges a patch into ONE language's provisioning slot (see byLang), leaving the other language's
  // slot untouched — the key to python and R showing independent progress in Settings. Same
  // identity-stable rule as applyUi: an unchanged slot must not re-render every listening card.
  const applyLang = (language: NotebookLanguage, patch: Partial<LangProvisionState>): void =>
    set((s) => {
      const slot = { preparing: false, ...s.byLang[language], ...patch }
      if (sameShallow(s.byLang[language], slot)) return s
      return {
        byLang: {
          ...s.byLang,
          [language]: slot
        }
      }
    })

  // Reflect the main-process recovery quarantine (ProvisionStatus.*RecoveryBlocked) into each language's
  // slot, so a blocked-but-ready env surfaces the Reset affordance. Only manages the recovery message:
  // set it when blocked and not actively (re)building, clear only that specific message when unblocked —
  // never stomping a live rebuild's progress or an unrelated provision error.
  const applyRecoveryBlocks = (status: ProvisionStatus): void => {
    const blocked: Record<NotebookLanguage, boolean> = {
      python: status.pythonRecoveryBlocked ?? false,
      r: status.rRecoveryBlocked ?? false
    }
    set((s) => {
      let changed = false
      const byLang = { ...s.byLang }
      for (const language of ['python', 'r'] as const) {
        const cur = byLang[language] ?? { preparing: false }
        if (blocked[language]) {
          if (cur.preparing || cur.error === RECOVERY_BLOCKED_MESSAGE) continue // let a rebuild settle
          byLang[language] = { ...cur, preparing: false, error: RECOVERY_BLOCKED_MESSAGE }
          changed = true
        } else if (cur.error === RECOVERY_BLOCKED_MESSAGE) {
          byLang[language] = { ...cur, error: undefined } // block cleared (e.g. after Reset/restart)
          changed = true
        }
      }
      // This runs after every status re-read, so a no-op must not produce a new state object — see
      // sameShallow: the re-read loop feeds on fresh identities.
      return changed ? { byLang } : s
    })
  }

  return {
    ...createInitialNotebookEnvState(),

    // Mirror the main-process provisioner: hydrate once, then track each progress broadcast and
    // re-read the authoritative status so provisioning/ready flags stay in lockstep (update-store idiom).
    init: async () => {
      const bridge = window.api?.notebookEnv
      if (!bridge) return
      // Idempotency guard: only ever register one onProgress listener per bridge instance, even
      // though init() has two legitimate call sites. Still refresh getStatus() below on every call
      // so a re-mount picks up any state change that happened while unmounted.
      if (!subscribedBridges.has(bridge)) {
        subscribedBridges.add(bridge)
        bridge.onProgress((progress) => {
          applyUi({
            progress,
            ...(progress.scope === 'python' || progress.scope === 'r'
              ? { scope: progress.scope }
              : progress.scope === 'upgrade'
                ? { scope: undefined }
                : {}),
            error: progress.phase === 'error' ? progress.message : undefined
          })
          // Route a language-tagged event into that language's slot so its card advances/settles on its
          // own. Explicit UI runs stay preparing until their IPC call returns; `done` can arrive before
          // that boundary. Automatic runs have no awaiting caller, so their terminal event settles them.
          const language = progress.language
          if (language) {
            const terminal = progress.phase === 'done' || progress.phase === 'error'
            trackLanguageProgress(language, progress.operationId, terminal)
            const settled = terminal && !explicitRuns.has(language)
            applyLang(language, {
              progress,
              error: progress.phase === 'error' ? progress.message : undefined,
              preparing: !settled
            })
          } else if (progress.phase === 'error') {
            // Safety net: an error we can't attribute to a language (e.g. a startup-gate failure) must
            // still settle every preparing card, or a slot whose progress events were tagged would stay
            // stuck spinning. Clear preparing for all in-flight languages without guessing whose it was.
            set((s) => ({
              byLang: Object.fromEntries(
                Object.entries(s.byLang).map(([lang, state]) => [
                  lang,
                  explicitRuns.has(lang as NotebookLanguage)
                    ? state
                    : { ...(state as LangProvisionState), preparing: false }
                ])
              )
            }))
          }
          // Re-read the authoritative status only when the run settles. The provisioner broadcasts a
          // progress tick per frame, so re-reading (and rewriting) on every tick turns the progress bar
          // into a write storm: each write notifies every consumer of this store, and on the packaged
          // app — where the bridge answers fastest — that overflowed React's update-depth guard (error
          // #185). Progress itself already carries what the banner shows, so nothing is lost in between.
          if (progress.phase === 'done' || progress.phase === 'error') {
            void bridge.getStatus().then((status) => {
              applyUi({ status })
              applyRecoveryBlocks(status)
            })
          }
        })
      }
      const status = await bridge.getStatus()
      applyUi({ status })
      applyRecoveryBlocks(status)
    },

    provision: async (lang) => {
      const bridge = window.api?.notebookEnv
      const scope: ProvisionScope = lang
      applyUi({ scope, progress: undefined, error: undefined })
      // Mark this language preparing immediately (before the first progress event) so its card shows
      // setup right away; clears when the run settles below or via its terminal progress event.
      applyLang(lang, { preparing: true, error: undefined })
      if (!bridge) {
        applyLang(lang, { preparing: false })
        return
      }
      const run = beginExplicitRun(lang)
      let status: ProvisionStatus | undefined
      let failure: string | undefined
      try {
        await bridge.provision(lang, run.operationId)
        status = await bridge.getStatus()
        applyUi({ status })
      } catch (e) {
        failure = errorText(e)
      } finally {
        const completion = endExplicitRun(lang, run)
        if (
          completion.last &&
          (completion.ownsLatestProgress || completion.newerProgressTerminal)
        ) {
          const error = completion.ownsLatestProgress
            ? failure
            : (get().byLang[lang]?.error ?? failure)
          applyUi({ error })
          // Only the last overlapping request settles the shared language card. Clear preparing before
          // applying recovery state so a completed rebuild can surface a still-active quarantine.
          applyLang(lang, { preparing: false, error })
          if (status) applyRecoveryBlocks(status)
        }
      }
    },

    // Aborts an in-flight provision. The main process settles the aborted run and broadcasts its
    // terminal progress; refresh status so the UI leaves the preparing state promptly.
    cancel: async (lang) => {
      const bridge = window.api?.notebookEnv
      // Clear this language's preparing state immediately so its card leaves the setup state promptly.
      applyLang(lang, { preparing: false })
      if (!bridge) return
      try {
        // Forward the language so cancelling this card never aborts the OTHER language's in-flight run.
        await bridge.cancel(lang)
        const status = await bridge.getStatus()
        applyUi({ status })
        // Reapply recovery blocks: if the cancelled run was a queued Reset whose block was never cleared,
        // status.*RecoveryBlocked is still true and the Reset button must stay visible — not be replaced
        // by an empty/cancelled state that hides it.
        applyRecoveryBlocks(status)
      } catch (e) {
        applyUi({ error: errorText(e) })
      }
    },

    retry: async () => {
      const scope = get().scope
      await get().provision(scope === 'r' ? 'r' : 'python')
    },

    // Explicit user recovery for a runtime that is recovery-BLOCKED (a prior setup's worker couldn't be
    // confirmed stopped). Repair force-clears the quarantine and rebuilds — the reachable "Reset" entry
    // for a block that won't clear on its own. Tracked per-language like provision.
    reset: async (lang) => {
      const bridge = window.api?.notebookEnv
      applyUi({ scope: lang, error: undefined })
      applyLang(lang, { preparing: true, error: undefined })
      if (!bridge) {
        applyLang(lang, { preparing: false })
        return
      }
      const run = beginExplicitRun(lang)
      let status: ProvisionStatus | undefined
      let failure: string | undefined
      try {
        await bridge.repair(lang, run.operationId)
        status = await bridge.getStatus()
        applyUi({ status })
      } catch (e) {
        failure = errorText(e)
      } finally {
        const completion = endExplicitRun(lang, run)
        if (
          completion.last &&
          (completion.ownsLatestProgress || completion.newerProgressTerminal)
        ) {
          const error = completion.ownsLatestProgress
            ? failure
            : (get().byLang[lang]?.error ?? failure)
          applyUi({ error })
          applyLang(lang, { preparing: false, error })
          if (status) applyRecoveryBlocks(status)
        }
      }
    }
  }
})
