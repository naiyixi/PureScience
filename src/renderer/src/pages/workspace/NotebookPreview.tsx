import { useLanguage } from '@/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { PreviewToolItem } from '@/stores/preview-workbench-store'
import { computeStaleRunIds } from '../../../../shared/run-dependencies'
import { Braces, FilePenLine, Power, RotateCw } from 'lucide-react'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { cn } from '@/lib/utils'
import type {
  NotebookRuntimeBindings,
  NotebookRuntimeListing
} from '../../../../shared/notebook-runtime'
import { WriteAuditPanel } from './WriteAuditPanel'
import {
  isVariableToken as isVariableTokenSuggestion,
  suggestVariableNames
} from './notebook-variable-suggestions'

import type {
  NotebookEnvironmentStatus,
  NotebookKernelKind,
  NotebookLanguage,
  NotebookRunRecord,
  NotebookSessionReference,
  NotebookSessionState,
  NotebookVariable
} from '../../../../shared/notebook'
import { EnvProvisionOverlay } from './EnvProvisionOverlay'
import { shouldProvisionR } from './lazy-r'
import { notebookGated } from './provisioning-view'
import { NotebookCodeBlock } from './notebook-code'
import { NotebookRunOutputs } from './NotebookRunOutputs'
import { NotebookInputDataStrip } from './NotebookInputDataStrip'
import {
  resolveRunErrorLine,
  environmentLabel,
  isProblemRunStatus,
  problemBadgeLabel,
  kernelKindLabel,
  kernelOriginLabel,
  resolveRunEnvironment,
  resolveRunKernelKind
} from './notebook-cell-utils'

// Fixed tab order for the per-kernel switcher.
const KERNEL_KIND_ORDER: NotebookKernelKind[] = ['python', 'r', 'repl', 'bash']

// Small dot color for the per-env status badge, reusing the divider's busy/idle vocabulary plus a
// distinct color for the terminal states (design D6).
const envStatusDotClass = (status: NotebookEnvironmentStatus['status'] | undefined): string => {
  switch (status) {
    case 'running':
    case 'starting':
    case 'restarting':
      return 'bg-accent'
    case 'error':
      return 'bg-danger-000'
    case 'terminated':
    case 'shutdown':
      return 'bg-text-300'
    default:
      return 'bg-text-200'
  }
}

export type NotebookPreviewItem = PreviewToolItem & {
  toolKind: 'notebook'
  notebook: NotebookSessionReference
}

type NotebookPreviewProps = {
  item: NotebookPreviewItem
}

// Converts any IPC failure into displayable text without losing non-Error values.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Reuses the stable notebook routing fields for every renderer IPC request.
const createNotebookRequest = (
  notebook: NotebookSessionReference
): {
  projectName: string
  sessionId: string
  workspaceCwd: string
} => ({
  projectName: notebook.projectName,
  sessionId: notebook.sessionId,
  workspaceCwd: notebook.workspaceCwd
})

// Read-only live-namespace browser: names, types, shapes, and bounded
// previews of the running Python/R kernel, refreshed after each execution. The kernel answers only
// while alive; an undefined response renders as "unavailable" (no kernel started just to browse).
const NotebookVariablesPanel = ({
  variables,
  state,
  onRefresh
}: {
  variables: NotebookVariable[]
  state: 'idle' | 'loading' | 'unavailable' | 'refreshing'
  onRefresh: () => void
}): React.JSX.Element => {
  const { t } = useLanguage()

  if (state === 'unavailable') {
    return (
      <div className="grid min-h-40 place-items-center px-4 py-6 text-center">
        <div>
          <Braces className="mx-auto size-5 text-text-300" aria-hidden="true" />
          <p className="mt-2 text-xs text-text-300">{t('ws.notebookVariablesUnavailable')}</p>
        </div>
      </div>
    )
  }

  if (state === 'loading' && variables.length === 0) {
    return (
      <div className="px-4 py-6 text-xs text-text-300" data-testid="notebook-variables-loading">
        {t('ws.notebookVariablesLoading')}
      </div>
    )
  }

  if (variables.length === 0) {
    return (
      <div className="px-4 py-6 text-xs text-text-300" data-testid="notebook-variables-empty">
        {t('ws.notebookVariablesEmpty')}
      </div>
    )
  }

  return (
    <div className="px-3 py-2" data-testid="notebook-variables">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium text-text-300">
          {variables.length} {t('ws.notebookVariablesCount')}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-border-200 px-2 py-0.5 text-[11px] text-text-200 transition-colors hover:bg-bg-200"
          data-testid="notebook-variables-refresh"
        >
          {state === 'refreshing'
            ? t('ws.notebookVariablesRefreshing')
            : t('ws.notebookVariablesRefresh')}
        </button>
      </div>
      <div className="divide-y divide-border-100 rounded-md border border-border-100">
        {variables.map((variable) => (
          <div key={variable.name} className="flex items-baseline gap-2 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-000">
              {variable.name}
            </span>
            <span className="shrink-0 rounded bg-bg-300 px-1.5 py-0.5 font-mono text-[10px] text-text-200">
              {variable.type}
            </span>
            {variable.shape ? (
              <span className="shrink-0 font-mono text-[10px] text-text-300">{variable.shape}</span>
            ) : null}
            {variable.preview ? (
              <span
                className="max-w-64 truncate font-mono text-[10px] text-text-300"
                title={variable.preview}
              >
                {variable.preview}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

// Collapses stdout, stderr, and traceback into the text block shown under each run.
const getRunOutputText = (run: NotebookRunRecord | undefined): string => {
  if (!run) return ''

  return [run.text.stdout, run.text.stderr, run.text.traceback]
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

// Displays one durable execution record from run.json in chronological order. The zero-based index
// is the cell number shown in [n], and a failed run marks the offending line.
const NotebookRunCell = ({
  run,
  index,
  isStale = false,
  onRunAgain,
  runAgainBlockedReason
}: {
  run: NotebookRunRecord
  index: number
  isStale?: boolean
  // Runs this cell again through the same interpreter the agent uses. Absent when the pane is not
  // allowed to drive the notebook at all (for example while an environment is still provisioning).
  onRunAgain?: (run: NotebookRunRecord) => void
  // Why the control is unavailable right now, shown on the row instead of leaving a dead button.
  runAgainBlockedReason?: string
}): React.JSX.Element => {
  const { t } = useLanguage()
  const isProblem = isProblemRunStatus(run.status)
  const errorLine = isProblem ? resolveRunErrorLine(run) : undefined
  const problemLabel = problemBadgeLabel(run, errorLine, t)
  const kind = resolveRunKernelKind(run)
  const originLabel = kernelOriginLabel(kind)

  return (
    <div className="px-4 py-3" data-testid="notebook-cell">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-text-300">[{index}]</span>
          <span className="rounded bg-bg-300 px-1.5 py-0.5 text-text-200">{kind}</span>
          {run.source === 'user' ? (
            <span className="rounded bg-accent px-1.5 py-0.5 font-medium text-accent">you</span>
          ) : null}
          {isStale ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600"
              data-testid="notebook-cell-stale"
            >
              {t('ws.notebookStale')}
            </span>
          ) : null}
          {isProblem ? (
            <span
              className={
                run.status === 'failed'
                  ? 'rounded bg-danger-000 px-1.5 py-0.5 font-medium text-white'
                  : 'rounded bg-danger-900 px-1.5 py-0.5 text-danger-000'
              }
              data-testid="notebook-cell-problem"
            >
              {problemLabel}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {originLabel ? (
            <span className="font-mono text-text-300" data-testid="notebook-cell-origin">
              {originLabel}
            </span>
          ) : null}
          {onRunAgain ? (
            <button
              aria-label={runAgainBlockedReason ?? t('ws.notebookRunCellAgain')}
              className="rounded border border-border-200 px-1.5 py-0.5 font-medium text-text-200 transition-colors hover:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="notebook-cell-rerun"
              disabled={runAgainBlockedReason !== undefined}
              onClick={() => onRunAgain(run)}
              title={runAgainBlockedReason ?? t('ws.notebookRunCellAgain')}
              type="button"
            >
              {t('ws.notebookRunCellAgain')}
            </button>
          ) : null}
        </div>
      </div>
      {runAgainBlockedReason ? (
        <p className="mb-2 text-[11px] text-text-300" data-testid="notebook-cell-rerun-blocked">
          {runAgainBlockedReason}
        </p>
      ) : null}
      <NotebookInputDataStrip
        inputFiles={run.inputFiles ?? []}
        className="mb-2 rounded-md border border-border-100 bg-bg-100 px-2 py-1.5"
      />
      <NotebookCodeBlock
        code={run.script}
        language={kind === 'repl' ? 'javascript' : kind}
        highlightLine={errorLine}
      />
      <NotebookRunOutputs run={run} />
    </div>
  )
}

// Mirrors terminal-originated runs in the bottom terminal scrollback.
const TerminalScrollback = ({ runs }: { runs: NotebookRunRecord[] }): React.JSX.Element => (
  <div
    className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-5"
    data-testid="kernel-terminal-scrollback"
  >
    {runs
      .filter((run) => run.inputKind === 'terminal')
      .map((run) => (
        <div key={run.runId} className="whitespace-pre-wrap">
          <div>
            <span className="text-text-300">&gt;&gt;&gt; </span>
            <span className="text-text-100">{run.script}</span>
          </div>
          {getRunOutputText(run) ? (
            <div className={isProblemRunStatus(run.status) ? 'text-danger-000' : 'text-text-200'}>
              {getRunOutputText(run)}
            </div>
          ) : null}
        </div>
      ))}
  </div>
)

// Captures one-line terminal code and submits on Enter while Shift+Enter keeps editing. While
// typing, it suggests live kernel variable names (matched against the current token prefix);
// Tab/click accepts, Arrow keys navigate, Escape dismisses.
const TerminalInput = ({
  code,
  disabled,
  onChange,
  onSubmit,
  variableNames
}: {
  code: string
  disabled: boolean
  onChange: (value: string) => void
  onSubmit: () => void
  // Live kernel variable names for in-line suggestions; empty hides the affordance.
  variableNames: string[]
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const [showSuggestions, setShowSuggestions] = useState(false)
  // The variable name currently being typed (the last whitespace-delimited token starting with
  // a letter/underscore); suggestions are matched against its prefix.
  const currentToken = code.split(/[\s()[\].,;:]/).at(-1) ?? ''
  const isVariableToken = isVariableTokenSuggestion(code)
  const suggestions = useMemo(
    () => suggestVariableNames(code, variableNames),
    [code, variableNames]
  )

  const applySuggestion = (): void => {
    const suggestion = suggestions[suggestionIndex]
    if (!suggestion) return
    // Replace the trailing token with the accepted variable name, keeping any earlier text.
    const replaceAt = code.length - currentToken.length
    onChange(`${code.slice(0, replaceAt)}${suggestion}`)
    setShowSuggestions(false)
    setSuggestionIndex(0)
  }

  // Match Python REPL ergonomics while avoiding submit during IME composition. Tab accepts the
  // highlighted suggestion; Escape closes the suggestion list.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape' && suggestions.length > 0) {
      event.preventDefault()
      setShowSuggestions(false)
      return
    }
    if (event.key === 'Tab' && suggestions.length > 0) {
      event.preventDefault()
      applySuggestion()
      return
    }
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault()
      setSuggestionIndex((index) => (index + 1) % suggestions.length)
      return
    }
    if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault()
      setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return

    event.preventDefault()
    onSubmit()
  }

  // Recompute the highlight when the token or list changes; open the list while typing a match.
  // The setters reset ephemeral UI navigation state in response to the suggestion list changing,
  // never in the same tick as a render the user observes — no cascading renders.
  /* eslint-disable react-hooks/set-state-in-effect -- see note above */
  useEffect(() => {
    setSuggestionIndex(0)
    setShowSuggestions(suggestions.length > 0 && isVariableToken)
  }, [isVariableToken, suggestions])
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="relative">
      <div className="flex items-start gap-2 border-t border-border-100/60 px-3 py-2">
        <span className="pt-0.5 font-mono text-xs text-primary">&gt;&gt;&gt;</span>
        <textarea
          rows={1}
          value={code}
          disabled={disabled}
          placeholder={t('workspace.runCodePlaceholder')}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className="min-h-0 flex-1 resize-none bg-transparent font-mono text-xs text-text-000 outline-none placeholder:text-text-300 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="kernel-terminal-input"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => setShowSuggestions(false)}
          aria-expanded={showSuggestions ? 'true' : 'false'}
          aria-controls={showSuggestions ? 'kernel-variable-suggestions' : undefined}
        />
      </div>
      {showSuggestions && suggestions.length > 0 ? (
        <div
          id="kernel-variable-suggestions"
          role="listbox"
          aria-label={t('workspace.variableSuggestions')}
          className="absolute bottom-full left-3 z-10 max-h-48 w-64 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
          data-testid="kernel-variable-suggestions"
        >
          {suggestions.map((name, index) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={index === suggestionIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setSuggestionIndex(index)
                applySuggestion()
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-xs ${
                index === suggestionIndex
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60'
              }`}
            >
              <span className="truncate">{name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// Renders the notebook preview and keeps it synchronized with main-process runtime events.
const NotebookPreview = ({ item }: NotebookPreviewProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [notebookState, setNotebookState] = useState<NotebookSessionState | undefined>()
  const [terminalCode, setTerminalCode] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // One-line receipt for a cell the user re-ran, so the outcome is attributable to their action even
  // when they are not watching the run list.
  const [rerunNotice, setRerunNotice] = useState<string | null>(null)
  const [isRestarting, setIsRestarting] = useState(false)
  // IC15: closing the session's interpreter is its own in-flight state, so the two kernel controls can
  // never both be mid-action, and the receipt below names what the last one did.
  const [isClosingKernel, setIsClosingKernel] = useState(false)
  const [kernelNotice, setKernelNotice] = useState<string | null>(null)
  const [activeKind, setActiveKind] = useState<NotebookKernelKind>('python')
  // Selected environment within the active python/r pane; undefined lets the effective-env
  // computation below default to the first (canonical-default-first) environment.
  const [activeEnv, setActiveEnv] = useState<string | undefined>(undefined)

  // Greys the pane while python is unavailable or an upgrade is running (spec §6.5).
  const envStatus = useNotebookEnvStore((s) => s.status)
  const provisionUi = useNotebookEnvStore((s) => s.ui)
  const retryProvision = useNotebookEnvStore((s) => s.retry)
  const provision = useNotebookEnvStore((s) => s.provision)
  const cancelProvision = useNotebookEnvStore((s) => s.cancel)
  const gated = notebookGated(envStatus, provisionUi, item.notebook.sessionId)
  // Cancel is offered only where the runtime can really abort: a python/R provision. An additive
  // upgrade runs without an abort controller (and the serialized wrapper drops a per-language cancel
  // for it), so that state shows no Cancel rather than a button that does nothing.
  const cancellableScope: NotebookLanguage | undefined =
    provisionUi.kind === 'preparing' &&
    (provisionUi.scope === 'python' || provisionUi.scope === 'r')
      ? provisionUi.scope
      : undefined
  const isPreparingR =
    provisionUi.kind === 'preparing' &&
    provisionUi.scope === 'r' &&
    (!provisionUi.sessionId || provisionUi.sessionId === item.notebook.sessionId)

  // First-time R selection kicks off the lazy ~1GB R download in the background; Python stays
  // usable throughout (D6 — see lazy-r.ts). R-kernel execution routing is wired later in E5.
  const onSelectLanguage = (lang: NotebookLanguage): void => {
    if (shouldProvisionR(envStatus, lang)) void provision('r')
  }

  // Keeps state assignment isolated so load paths and event paths share the same update hook.
  const applyNotebookState = useCallback((nextState: NotebookSessionState): void => {
    setNotebookState(nextState)
  }, [])

  // Variables view state: the panel is read-only and refreshed after each
  // execution; it never starts a kernel just to browse.
  const [variablesOpen, setVariablesOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [variables, setVariables] = useState<NotebookVariable[]>([])
  const [variablesState, setVariablesState] = useState<
    'idle' | 'loading' | 'unavailable' | 'refreshing'
  >('idle')

  const loadVariables = useCallback(async (): Promise<void> => {
    setVariablesState((current) =>
      current === 'loading' || current === 'refreshing' ? current : 'loading'
    )
    try {
      const result = await window.api.notebook.inspectVariables(
        createNotebookRequest(item.notebook)
      )
      if (!result) {
        setVariables([])
        setVariablesState('unavailable')
        return
      }
      setVariables(result.variables)
      setVariablesState('idle')
    } catch {
      setVariables([])
      setVariablesState('unavailable')
    }
  }, [item.notebook])

  // Refresh the snapshot when the kernel publishes changes while the panel is open.
  useEffect(() => {
    if (!variablesOpen) return
    // Defer so the first synchronous setState in loadVariables happens after the
    // effect phase (avoids a cascading render warning on open).
    const handle = window.setTimeout(() => {
      void loadVariables()
    }, 0)
    return () => window.clearTimeout(handle)
  }, [variablesOpen, item.notebook, notebookState?.activeRunId, loadVariables])

  // Cross-run dependency staleness: a later completed run that rewrote one of this run's written
  // variables makes its output reflect an earlier state.
  const staleRunIds = useMemo(
    () => computeStaleRunIds(notebookState?.runs ?? []),
    [notebookState?.runs]
  )

  // Reads the latest notebook state from main, including full run history from run.json.
  const loadNotebookState = useCallback(async (): Promise<void> => {
    setIsLoading(true)

    try {
      const nextState = await window.api.notebook.state(createNotebookRequest(item.notebook))

      applyNotebookState(nextState)
      setActionError(null)
    } catch (error) {
      setActionError(getErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [applyNotebookState, item.notebook])

  // Defer the initial state load until after the component has mounted.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadNotebookState()
    }, 0)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [loadNotebookState])

  // Reload whenever the shared runtime publishes a change for this notebook session.
  useEffect(() => {
    return window.api.notebook.onChanged((event) => {
      if (event.sessionId === item.notebook.sessionId) {
        void loadNotebookState()
      }
    })
  }, [item.notebook.sessionId, loadNotebookState])

  // Sends terminal code through the same notebook interpreter and history path as agent code.
  const submitTerminalCode = async (): Promise<void> => {
    const code = terminalCode.trim()

    if (!code || notebookState?.activeWrite?.source === 'agent' || notebookState?.activeRunId) {
      return
    }

    // Clear optimistically so a running terminal command feels like a REPL submission.
    setTerminalCode('')
    setIsSubmitting(true)
    setActionError(null)

    try {
      await window.api.notebook.execute({
        ...createNotebookRequest(item.notebook),
        code,
        source: 'user',
        inputKind: 'terminal'
      })

      await loadNotebookState()
    } catch (error) {
      setTerminalCode(code)
      setActionError(getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  // Agent writes and active executions lock terminal input to avoid interleaving code streams.
  const isAgentWriting = notebookState?.activeWrite?.source === 'agent'
  const isNotebookBusy = isSubmitting || Boolean(notebookState?.activeRunId)
  const isTerminalLocked =
    isLoading || isSubmitting || isAgentWriting || Boolean(notebookState?.activeRunId) || gated
  // Runs one existing cell through the interpreter. The agent uses the same command (notebook:run-cell)
  // to re-run its own cells; until now nothing in the window could, so a stale cell was a dead end in
  // the UI even though the capability existed.
  const rerunCell = async (run: NotebookRunRecord): Promise<void> => {
    if (isNotebookBusy || (isAgentWriting && notebookState?.activeWrite?.cellId === run.cellId)) {
      return
    }

    setActionError(null)
    setRerunNotice(null)

    const environment = resolveRunEnvironment(run)

    try {
      const summary = await window.api.notebook.runCell({
        ...createNotebookRequest(item.notebook),
        cellId: run.cellId,
        source: 'user',
        ...(environment ? { environment } : {})
      })

      setRerunNotice(t('ws.notebookRerunDone').replace('{status}', summary.status) as string)
      await loadNotebookState()
    } catch (error) {
      setActionError(getErrorMessage(error))
    }
  }

  // Why a row cannot be re-run; undefined means the control is live. Reasons are concrete rather than a
  // blanket disable: a run in flight (any kernel) or the agent still streaming code into that very cell.
  const rerunBlockedReasonFor = (run: NotebookRunRecord): string | undefined => {
    if (gated) return t('ws.notebookRunCellBlockedProvisioning')
    if (isNotebookBusy) return t('ws.notebookRunCellBlockedBusy')
    if (isAgentWriting && notebookState?.activeWrite?.cellId === run.cellId) {
      return t('ws.notebookRunCellBlockedWriting')
    }

    return undefined
  }

  const runs = notebookState?.runs ?? notebookState?.recentRuns ?? []

  // Surface a tab only for kernel kinds that actually produced a run — no default python/r tabs on a
  // fresh notebook; a kernel's tab appears once it has been used.
  const kindsWithRuns = new Set(runs.map(resolveRunKernelKind))
  const visibleKinds = KERNEL_KIND_ORDER.filter((kind) => kindsWithRuns.has(kind))
  // Default to the first kind (in fixed order) that actually has runs; fall back to python only when
  // there are no runs at all (so an empty notebook doesn't render a blank non-python pane).
  const effectiveActiveKind = visibleKinds.includes(activeKind)
    ? activeKind
    : (KERNEL_KIND_ORDER.find((kind) => kindsWithRuns.has(kind)) ?? visibleKinds[0] ?? 'python')
  const kindRuns = runs.filter((run) => resolveRunKernelKind(run) === effectiveActiveKind)

  // Per-environment selector (design D6): only python/r are env-scoped. Distinct env names among
  // this kind's runs, canonical default first, so the selector (when shown) reads default-first.
  const isEnvScopedKind = effectiveActiveKind === 'python' || effectiveActiveKind === 'r'
  const envNames = isEnvScopedKind
    ? Array.from(
        new Set(
          kindRuns.map(resolveRunEnvironment).filter((env): env is string => env !== undefined)
        )
      ).sort((a, b) => {
        const aIsDefault = a === 'default-python' || a === 'default-r'
        const bIsDefault = b === 'default-python' || b === 'default-r'
        if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1
        return a.localeCompare(b)
      })
    : []
  // Hide the selector entirely when there's at most one environment — zero visual change for the
  // common single-default-env case.
  const showEnvSelector = envNames.length > 1
  const effectiveActiveEnv = showEnvSelector
    ? envNames.includes(activeEnv ?? '')
      ? (activeEnv as string)
      : envNames[0]
    : undefined
  const visibleRuns = showEnvSelector
    ? kindRuns.filter((run) => resolveRunEnvironment(run) === effectiveActiveEnv)
    : kindRuns

  // Live status for one env option in the selector, matched by (kind, env) against the per-env
  // status view (defaulting the env name the same way resolveRunEnvironment does).
  const envOptionStatus = (envName: string): NotebookEnvironmentStatus['status'] | undefined =>
    notebookState?.environments.find((entry) => {
      if (entry.kind !== effectiveActiveKind) return false
      const entryEnvName =
        entry.environment ?? (entry.kind === 'r' ? 'default-r' : 'default-python')
      return entryEnvName === envName
    })?.status

  // IC14: the session's runtime binding, straight from the main process — the same three calls the agent's
  // notebook runtime tools make, so the window cannot bind or switch around that gate. An unavailable
  // binding carries the app's own `reason`, which is shown on the row instead of leaving a dead control.
  const [runtimeListing, setRuntimeListing] = useState<{
    runtimes: NotebookRuntimeListing[]
    bindings: NotebookRuntimeBindings
  } | null>(null)
  const [runtimeBindingError, setRuntimeBindingError] = useState<string | null>(null)
  const [runtimeBindingBusy, setRuntimeBindingBusy] = useState(false)
  const runtimeSessionId = item.notebook.sessionId
  // Every notebook call carries the session context (sessionId + workspaceCwd, plus the project name
  // when the pane knows it), so the main process can resolve the same session the rest of the pane uses.
  const runtimeSessionContext = {
    sessionId: runtimeSessionId,
    workspaceCwd: item.notebook.workspaceCwd,
    projectName: item.notebook.projectName
  }
  const loadRuntimes = useCallback(async (): Promise<void> => {
    try {
      // Built inline (not from the object below) so this callback's dependencies stay primitives and the
      // hook rules can see exactly what it reads.
      const listing = await window.api.notebook.listRuntimes({
        sessionId: runtimeSessionId,
        workspaceCwd: item.notebook.workspaceCwd,
        projectName: item.notebook.projectName
      })
      setRuntimeListing(listing)
      setRuntimeBindingError(null)
    } catch (error) {
      setRuntimeBindingError(error instanceof Error ? error.message : String(error))
    }
  }, [runtimeSessionId, item.notebook.workspaceCwd, item.notebook.projectName])
  useEffect(() => {
    // Defer like the notebook-state load above: a synchronous setState in the effect phase trips
    // react-hooks/set-state-in-effect, and the listing is not needed before the pane's first paint.
    const handle = window.setTimeout(() => {
      void loadRuntimes()
    }, 0)
    return () => window.clearTimeout(handle)
  }, [loadRuntimes])

  // Bind the first time and switch afterwards: the main process refuses to re-bind a different runtime
  // (bind_runtime) and its switch tears the current kernel down before rebinding, so the window must ask
  // for the right one instead of retrying blindly.
  const applyRuntime = async (runtimeId: string, bound: boolean): Promise<void> => {
    if (runtimeBindingBusy) return
    setRuntimeBindingBusy(true)
    setRuntimeBindingError(null)
    try {
      const request = {
        ...runtimeSessionContext,
        language: effectiveActiveKind as NotebookLanguage,
        runtimeId
      }
      if (bound) {
        await window.api.notebook.switchRuntime(request)
      } else {
        await window.api.notebook.bindRuntime(request)
      }
      // The write returns the new bindings, but the ROW's truth (bound flags, runnable, reasons) comes
      // from the listing, so re-read it rather than patching state by hand.
      await loadRuntimes()
    } catch (error) {
      setRuntimeBindingError(error instanceof Error ? error.message : String(error))
    } finally {
      setRuntimeBindingBusy(false)
    }
  }

  // R-only restart prompt: an R install/uninstall flags the active R env until its kernel restarts.
  const activeRuntimeBinding =
    runtimeListing?.bindings[effectiveActiveKind === 'r' ? 'r' : 'python']
  // An ABSENT binding means this language still resolves to the app-managed default, so the first
  // explicit choice is a bind; anything after that is a switch.
  const hasExplicitBinding = activeRuntimeBinding !== undefined
  const activeEnvName =
    effectiveActiveEnv ?? (effectiveActiveKind === 'r' ? 'default-r' : 'default-python')
  const restartRecommended =
    effectiveActiveKind === 'r' &&
    (notebookState?.environments.find((entry) => {
      if (entry.kind !== 'r') return false
      return (entry.environment ?? 'default-r') === activeEnvName
    })?.restartRecommended ??
      false)

  // Restarts the shared interpreter, replacing state with the fresh snapshot so the banner clears.
  const handleRestart = async (): Promise<void> => {
    setIsRestarting(true)
    setActionError(null)
    try {
      const next = await window.api.notebook.restart(createNotebookRequest(item.notebook))
      applyNotebookState(next)
      setKernelNotice(t('ws.notebookKernelRestarted'))
    } catch (error) {
      setActionError(getErrorMessage(error))
    } finally {
      setIsRestarting(false)
    }
  }

  // IC15: closes the session's interpreter — the same teardown the agent's runtime uses when a session
  // ends. The channel answers with a receipt rather than a state snapshot, so the pane re-reads the
  // session's truth; the next run lazily starts a fresh kernel. Main-process teardown already waits for
  // in-flight writes, so the pane only has to stop a second click while either control is running.
  const handleShutdown = async (): Promise<void> => {
    setIsClosingKernel(true)
    setActionError(null)
    try {
      await window.api.notebook.shutdown(createNotebookRequest(item.notebook))
      setKernelNotice(t('ws.notebookKernelClosed'))
      await loadNotebookState()
    } catch (error) {
      setActionError(getErrorMessage(error))
    } finally {
      setIsClosingKernel(false)
    }
  }
  // Both controls are serialized against each other; the main process owns draining in-flight work.
  const kernelControlBusy = isRestarting || isClosingKernel

  return (
    <section
      className="relative flex h-full min-w-0 flex-col overflow-hidden bg-bg-000"
      data-testid="kernel-notebook-pane"
    >
      {gated ? (
        <EnvProvisionOverlay
          ui={provisionUi}
          onRetry={() => void retryProvision()}
          {...(cancellableScope ? { onCancel: () => void cancelProvision(cancellableScope) } : {})}
        />
      ) : null}
      <header
        className="flex shrink-0 items-center border-b border-border-100 px-2 py-1.5"
        data-testid="kernel-switcher"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {visibleKinds.map((kind) =>
            kind === 'r' ? (
              // R additionally kicks off lazy provisioning on first selection (D6 — see lazy-r.ts).
              <button
                key="r"
                type="button"
                data-testid="kernel-switcher-r"
                onClick={() => {
                  setActiveKind('r')
                  onSelectLanguage('r')
                }}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                  effectiveActiveKind === 'r'
                    ? 'bg-bg-300 text-text-000'
                    : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
                )}
              >
                {isPreparingR ? 'R (preparing…)' : 'R'}
              </button>
            ) : (
              <button
                key={kind}
                type="button"
                data-testid={`kernel-switcher-${kind}`}
                onClick={() => setActiveKind(kind)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                  effectiveActiveKind === kind
                    ? 'bg-bg-300 text-text-000'
                    : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
                )}
              >
                {kernelKindLabel(kind)}
              </button>
            )
          )}
        </div>
        {/* IC15: the kernel's own controls, always present. Restart used to surface only when an R
            install/uninstall flagged a pending restart, so a python kernel — or an idle R one — had no
            visible way to be restarted or closed from the pane. */}
        <div className="flex shrink-0 items-center gap-1" data-testid="kernel-controls">
          <button
            type="button"
            data-testid="kernel-restart-button"
            disabled={kernelControlBusy}
            onClick={() => void handleRestart()}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-300 transition-colors',
              'hover:bg-bg-200 hover:text-text-100 disabled:opacity-50'
            )}
          >
            <RotateCw className="size-3.5" aria-hidden="true" />
            {isRestarting ? t('common.restarting') : t('ws.notebookRestartKernel')}
          </button>
          <button
            type="button"
            data-testid="kernel-shutdown-button"
            disabled={kernelControlBusy}
            onClick={() => void handleShutdown()}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-300 transition-colors',
              'hover:bg-bg-200 hover:text-text-100 disabled:opacity-50'
            )}
          >
            <Power className="size-3.5" aria-hidden="true" />
            {isClosingKernel ? t('ws.notebookClosingKernel') : t('ws.notebookCloseKernel')}
          </button>
          {kernelNotice ? (
            <span
              role="status"
              data-testid="notebook-kernel-notice"
              className="shrink-0 text-text-300"
            >
              {kernelNotice}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setVariablesOpen((open) => !open)}
          aria-pressed={variablesOpen}
          data-testid="notebook-variables-toggle"
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
            variablesOpen
              ? 'bg-bg-300 text-text-000'
              : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
          )}
        >
          <Braces className="size-3.5" aria-hidden="true" />
          {t('ws.notebookVariables')}
        </button>
        <button
          type="button"
          onClick={() => setAuditOpen((open) => !open)}
          aria-pressed={auditOpen}
          data-testid="notebook-write-audit-toggle"
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
            auditOpen
              ? 'bg-bg-300 text-text-000'
              : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
          )}
        >
          <FilePenLine className="size-3.5" aria-hidden="true" />
          {t('ws.notebookWriteAudit')}
        </button>
      </header>

      {showEnvSelector ? (
        <div
          className="flex shrink-0 items-center gap-1 border-b border-border-100 px-2 py-1"
          data-testid="env-selector"
        >
          {envNames.map((envName) => (
            <button
              key={envName}
              type="button"
              data-testid={`env-option-${envName}`}
              onClick={() => setActiveEnv(envName)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] transition-colors',
                effectiveActiveEnv === envName
                  ? 'bg-bg-200 text-text-100'
                  : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  envStatusDotClass(envOptionStatus(envName))
                )}
                data-testid={`env-option-${envName}-status`}
              />
              {environmentLabel(envName)}
            </button>
          ))}
        </div>
      ) : null}

      {isEnvScopedKind && runtimeListing ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-100 px-2 py-1 text-[11px]"
          data-testid="notebook-runtime-binding"
        >
          <span className="text-text-300">{t('ws.notebookRuntime')}</span>
          {runtimeListing.runtimes
            .filter((runtime) => runtime.language === effectiveActiveKind)
            .map((runtime) => (
              <button
                key={runtime.runtimeId}
                type="button"
                data-testid={`notebook-runtime-option-${runtime.runtimeId}`}
                disabled={runtimeBindingBusy || !runtime.runnable}
                title={
                  runtime.runnable
                    ? undefined
                    : (runtime.detail ?? t('ws.notebookRuntimeNotRunnable'))
                }
                onClick={() => {
                  // Already in use: nothing to do (a switch to the same runtime would tear the kernel
                  // down for no reason). Otherwise the FIRST explicit binding uses bindRuntime; once one
                  // exists, a different runtime needs switchRuntime — which the main process enforces.
                  if (runtime.bound) return
                  void applyRuntime(runtime.runtimeId, hasExplicitBinding)
                }}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 transition-colors',
                  runtime.bound
                    ? 'bg-bg-200 text-text-100'
                    : 'text-text-300 hover:bg-bg-200 hover:text-text-100',
                  !runtime.runnable && 'cursor-not-allowed opacity-60'
                )}
              >
                {runtime.label}
                {runtime.bound ? ` · ${t('ws.notebookRuntimeBound')}` : ''}
                {runtime.runnable ? '' : ` · ${t('ws.notebookRuntimeNotRunnable')}`}
              </button>
            ))}
          {runtimeListing.runtimes.filter((runtime) => runtime.language === effectiveActiveKind)
            .length === 0 ? (
            <span data-testid="notebook-runtime-empty">{t('ws.notebookRuntimeEmpty')}</span>
          ) : null}
          {/* Why the session's bound runtime cannot back a kernel — the app's own reason, kept on the row
              rather than left for the user to discover by running a cell. */}
          {runtimeListing.bindings[effectiveActiveKind === 'r' ? 'r' : 'python']?.status ===
          'unavailable' ? (
            <span role="status" data-testid="notebook-runtime-reason" className="text-text-300">
              {t('ws.notebookRuntimeUnavailable')}:{' '}
              {runtimeListing.bindings[effectiveActiveKind === 'r' ? 'r' : 'python']?.reason ?? ''}
            </span>
          ) : null}
          {runtimeBindingError !== null ? (
            <span
              role="alert"
              data-testid="notebook-runtime-error"
              className="text-destructive-100"
            >
              {runtimeBindingError}
            </span>
          ) : null}
        </div>
      ) : null}

      {restartRecommended ? (
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border-100 bg-bg-300 px-3 py-1.5 text-[11px] text-text-100"
          data-testid="r-restart-banner"
        >
          <span>{t('common.rKernelRestartHint')}</span>
          <button
            type="button"
            disabled={isRestarting}
            onClick={() => void handleRestart()}
            className="shrink-0 rounded-md border border-border-200 px-2 py-0.5 font-medium text-text-100 transition-colors hover:bg-bg-200 disabled:opacity-50"
            data-testid="r-restart-button"
          >
            {isRestarting ? t('common.restarting') : t('common.restartRKernel')}
          </button>
        </div>
      ) : null}

      {variablesOpen ? (
        <div
          className="min-h-0 flex-[2_1_0] overflow-auto border-b border-border-100"
          data-testid="notebook-variables-panel"
        >
          <NotebookVariablesPanel
            variables={variables}
            state={variablesState}
            onRefresh={() => void loadVariables()}
          />
        </div>
      ) : null}

      {auditOpen ? (
        <div
          className="min-h-0 flex-[2_1_0] overflow-auto border-b border-border-100"
          data-testid="notebook-write-audit-panel"
        >
          <WriteAuditPanel runs={runs} />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col" data-testid="operon-notebook-terminal-split">
        <div className="min-h-0 flex-[4_1_0] overflow-visible" data-testid="notebook-cells-panel">
          <div className="flex h-full min-h-0 flex-col overflow-auto">
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="notebook-cells">
              <div className="divide-y divide-border-100">
                {visibleRuns.map((run, index) => (
                  <NotebookRunCell
                    key={run.runId}
                    run={run}
                    index={index}
                    isStale={staleRunIds.has(run.runId)}
                    onRunAgain={rerunCell}
                    runAgainBlockedReason={rerunBlockedReasonFor(run)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div
          aria-orientation="horizontal"
          className="group relative flex shrink-0 select-none items-center justify-between gap-2 border-y border-border-200 bg-bg-200/70 px-3 py-1 text-[11px] text-text-300 outline-none transition-colors hover:bg-bg-200"
          data-testid="notebook-terminal-divider"
          role="separator"
        >
          <span>{t('ws.notebookKernelSharedWithAgent')}</span>
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-100 opacity-60 transition duration-150 group-hover:opacity-100" />
          <span>{isNotebookBusy ? t('ws.notebookKernelRunning') : t('ws.notebookKernelIdle')}</span>
        </div>

        <div className="min-h-0 flex-[1_1_0]" data-testid="notebook-terminal-panel">
          <div className="flex h-full min-h-0 flex-col bg-bg-200" data-testid="kernel-terminal">
            {actionError ? (
              <div className="border-b border-border-100/60 px-3 py-2 font-mono text-xs text-danger-000">
                {actionError}
              </div>
            ) : null}
            {rerunNotice ? (
              <div
                className="border-b border-border-100/60 px-3 py-2 font-mono text-xs text-text-300"
                data-testid="notebook-rerun-summary"
              >
                {rerunNotice}
              </div>
            ) : null}
            <TerminalScrollback runs={runs} />
            <TerminalInput
              code={terminalCode}
              disabled={isTerminalLocked}
              onChange={setTerminalCode}
              onSubmit={() => {
                void submitTerminalCode()
              }}
              variableNames={variables.map((variable) => variable.name)}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

export { NotebookPreview }
