import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  FUNCTION_MODEL_EVENT_REASONS,
  isFunctionModelId,
  type FunctionModelEvent,
  type FunctionModelEventReason,
  type FunctionModelId
} from '../../shared/function-models'

// The trail's shape belongs to the shared contract: the settings surface renders these entries, so the two
// sides must not each carry their own idea of what an entry is.
export type { FunctionModelEvent, FunctionModelEventReason }

/**
 * The trail a function leaves behind.
 *
 * A narrow model call the app makes for itself is invisible: it happens before the turn, it produces no
 * message, and when it does not use the model the user configured there is nothing on screen that says so.
 * These entries are that "so": what each function did, which model it used, and — when it took its
 * built-in path — whether that was because nobody configured it or because the configuration could not be
 * used. A competitor's equivalent stops at "these features use the first service"; this is what lets the
 * user ask why a particular run did not.
 *
 * Bounded on purpose: the file keeps the most recent entries and is trimmed on append, so a long session
 * cannot grow it without limit.
 */

export const FUNCTION_MODEL_EVENT_LOG_LIMIT = 200

const isReason = (value: unknown): value is FunctionModelEventReason =>
  typeof value === 'string' &&
  (FUNCTION_MODEL_EVENT_REASONS as readonly string[]).includes(value)

const sanitizeEvent = (value: unknown): FunctionModelEvent | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined
  if (!isFunctionModelId(raw.functionId)) return undefined
  if (raw.outcome !== 'used-model' && raw.outcome !== 'built-in') return undefined

  return {
    at: raw.at,
    functionId: raw.functionId,
    outcome: raw.outcome,
    ...(typeof raw.providerId === 'string' ? { providerId: raw.providerId } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(isReason(raw.reason) ? { reason: raw.reason } : {})
  }
}

export const functionModelEventLogPath = (configRoot: string): string =>
  join(configRoot, 'function-model-events.json')

/**
 * Reads the trail, newest last. An unreadable or malformed file reads as empty rather than throwing: the
 * log is a diagnostic, and losing it must never take a turn down with it.
 */
export const readFunctionModelEvents = (configRoot: string): FunctionModelEvent[] => {
  const path = functionModelEventLogPath(configRoot)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed
      .map(sanitizeEvent)
      .filter((entry): entry is FunctionModelEvent => entry !== undefined)
  } catch {
    return []
  }
}

/** Appends one entry and trims the file to the most recent `FUNCTION_MODEL_EVENT_LOG_LIMIT`. */
export const appendFunctionModelEvent = (
  configRoot: string,
  event: {
    functionId: FunctionModelId
    outcome: 'used-model' | 'built-in'
    providerId?: string
    model?: string
    reason?: FunctionModelEventReason
    at?: number
  }
): FunctionModelEvent => {
  const entry: FunctionModelEvent = { at: event.at ?? Date.now(), ...event }
  const path = functionModelEventLogPath(configRoot)
  const kept = readFunctionModelEvents(configRoot)
  const next = [...kept, entry].slice(-FUNCTION_MODEL_EVENT_LOG_LIMIT)

  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // A diagnostic that cannot be written is not a reason to fail the run it was describing.
  }

  return entry
}
