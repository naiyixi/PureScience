// The decision behind a function-level model slot for skill selection, written once.
//
// Two callers need the same three branches: the bridged turn path (a narrow call inside a real turn) and
// the on-demand probe the settings row offers ("run one selection now"). The probe exists to say what a
// turn would do, so a second implementation could only ever disagree with the first — hence one helper
// with the branch, and two thin adapters.

import type {
  FunctionModelEvent,
  FunctionModelEventReason,
  FunctionModelId
} from '../../shared/function-models'
import type { ResponsesBridgeTarget } from './responses-bridge'

// The narrow-call surface both callers already have: which model to use for this function, and where to
// report what actually happened. Structural on purpose — the ACP runtime and the settings service each
// satisfy it without exporting anything to the other.
export type FunctionModelSkillSelectionHost = {
  resolveFunctionModelTarget: (functionId: FunctionModelId) => Promise<{
    resolution: {
      override: { providerId: string; model: string } | null
      unusable: readonly FunctionModelEventReason[]
    }
    target?: ResponsesBridgeTarget
  }>
  recordFunctionModelEvent: (event: Omit<FunctionModelEvent, 'at'>) => void
}

// The sentence the on-demand probe selects for. Fixed on purpose: the probe's job is to exercise the
// branch and the model, not to judge the text, so the same sentence every time makes two runs comparable.
export const PROBE_SELECTION_TEXT =
  'Normalise a table of measurements, join it with a second table on sample id, and save a summary figure.'

// What the caller can show afterwards. Elapsed time is measured around the call that actually happened
// (including the built-in path, which is not free either) rather than estimated.
export type FunctionModelSkillSelectionOutcome = {
  outcome: 'used-model' | 'built-in'
  reason?: FunctionModelEventReason
  providerId?: string
  model?: string
  elapsedMs: number
}

export const runFunctionModelSkillSelection = async <T>(options: {
  functionId: FunctionModelId
  host?: FunctionModelSkillSelectionHost
  builtIn: () => Promise<T>
  runWithModel: (target: ResponsesBridgeTarget) => Promise<T>
  now?: () => number
  // Lets a caller that can tell more apart than "it threw" name the reason precisely — the probe
  // distinguishes a call that failed from one that was never attempted.
  classifyRunFailure?: (error: unknown) => FunctionModelEventReason
}): Promise<{ value: T; selection: FunctionModelSkillSelectionOutcome }> => {
  const now = options.now ?? Date.now
  if (!options.host) {
    // No settings wiring at all (a runtime without a settings service): the built-in path, and nowhere to
    // write a trail entry. Not a silent fallback — there is no configured model in this construction.
    return { value: await options.builtIn(), selection: { outcome: 'built-in', elapsedMs: 0 } }
  }

  const started = now()
  const { resolution, target } = await options.host.resolveFunctionModelTarget(options.functionId)
  if (!resolution.override || !target) {
    // "nobody configured it" and "the configured one cannot be used" are different facts, and the reason
    // keeps them apart in the trail.
    const reason: FunctionModelEventReason = resolution.unusable[0] ?? 'not-configured'
    options.host.recordFunctionModelEvent({
      functionId: options.functionId,
      outcome: 'built-in',
      reason
    })

    return {
      value: await options.builtIn(),
      selection: { outcome: 'built-in', reason, elapsedMs: now() - started }
    }
  }

  const override = resolution.override
  try {
    const value = await options.runWithModel(target)
    options.host.recordFunctionModelEvent({
      functionId: options.functionId,
      outcome: 'used-model',
      providerId: override.providerId,
      model: override.model
    })

    return {
      value,
      selection: {
        outcome: 'used-model',
        providerId: override.providerId,
        model: override.model,
        elapsedMs: now() - started
      }
    }
  } catch (error) {
    // A narrow call that failed must not fail the caller: the built-in path still runs, and the trail says
    // the configured model did not answer instead of leaving the fallback unexplained.
    const reason = options.classifyRunFailure?.(error) ?? 'call-failed'
    options.host.recordFunctionModelEvent({
      functionId: options.functionId,
      outcome: 'built-in',
      reason,
      providerId: override.providerId,
      model: override.model
    })

    return {
      value: await options.builtIn(),
      selection: {
        outcome: 'built-in',
        reason,
        providerId: override.providerId,
        model: override.model,
        elapsedMs: now() - started
      }
    }
  }
}
