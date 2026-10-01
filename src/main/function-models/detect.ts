import { appendChatCompletions } from '../settings/base-url'

import type {
  FunctionModelDetectionFailureReason,
  FunctionModelDetectionUsage
} from '../../shared/function-models'

/**
 * One real round trip to the model a function is pointed at.
 *
 * The point of a detection button is that it measures: it sends the smallest request the endpoint will
 * accept, times it, and reports what came back — including the token counts when the provider sends them.
 * A tick with no numbers would be a claim about a call nobody observed, and a failure that does not name
 * itself would send the user looking in the wrong place, so every outcome here is one of a closed set.
 */

export const FUNCTION_MODEL_DETECTION_TIMEOUT_MS = 20_000

/**
 * What the round trip itself can know. The provider id is deliberately absent: the detector only knows the
 * endpoint it was handed, and the caller that chose that endpoint adds the identity it actually used.
 */
export type FunctionModelDetectionOutcome =
  | { ok: true; elapsedMs: number; model: string; usage?: FunctionModelDetectionUsage }
  | {
      ok: false
      elapsedMs: number
      reason: FunctionModelDetectionFailureReason
      status?: number
      model?: string
    }

export type FunctionModelDetectionTarget = {
  baseUrl: string
  key?: string
  model: string
}

const usageOf = (value: unknown): FunctionModelDetectionUsage | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const pick = (name: string): number | undefined =>
    typeof raw[name] === 'number' && Number.isFinite(raw[name]) ? (raw[name] as number) : undefined
  const usage: FunctionModelDetectionUsage = {
    ...(pick('prompt_tokens') !== undefined ? { inputTokens: pick('prompt_tokens') } : {}),
    ...(pick('completion_tokens') !== undefined ? { outputTokens: pick('completion_tokens') } : {}),
    ...(pick('total_tokens') !== undefined ? { totalTokens: pick('total_tokens') } : {})
  }

  return Object.keys(usage).length === 0 ? undefined : usage
}

export const detectFunctionModelTarget = async ({
  target,
  fetchImpl = fetch,
  timeoutMs = FUNCTION_MODEL_DETECTION_TIMEOUT_MS,
  signal
}: {
  target: FunctionModelDetectionTarget
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<FunctionModelDetectionOutcome> => {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()

  const startedAt = Date.now()
  try {
    const response = await fetchImpl(appendChatCompletions(target.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(target.key ? { authorization: `Bearer ${target.key}` } : {})
      },
      body: JSON.stringify({
        model: target.model,
        stream: false,
        // The smallest body the endpoint will accept: this measures reachability and latency, not quality.
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }]
      }),
      signal: controller.signal
    })
    const elapsedMs = Date.now() - startedAt
    if (!response.ok) {
      return {
        ok: false,
        elapsedMs,
        reason: 'http-error',
        status: response.status,
        model: target.model
      }
    }

    const payload = (await response.json()) as { choices?: unknown; usage?: unknown }
    if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
      // A 200 without a completion is not a working model, and saying "ok" here would be the exact kind of
      // green that means nothing.
      return { ok: false, elapsedMs, reason: 'invalid-response', model: target.model }
    }

    const usage = usageOf(payload.usage)

    return { ok: true, elapsedMs, model: target.model, ...(usage ? { usage } : {}) }
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    const message = error instanceof Error ? error.message : String(error)

    return {
      ok: false,
      elapsedMs,
      reason: timedOut || /abort/i.test(message) ? 'timeout' : 'unreachable',
      model: target.model
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}
