import { randomUUID } from 'node:crypto'

import { diagnosticErrorFields, type Logger } from '../logger'

export type DiagnosticValue = string | number | boolean | null | undefined
export type DiagnosticFields = Record<string, DiagnosticValue>

export type DiagnosticOperation = {
  phase: (name: string, fields?: DiagnosticFields) => void
  /**
   * `name=12ms name2=340ms …` — each *phase's own duration* (the last one counted up to this moment), so a
   * caller that never completes (app startup) still reports where time went, in the same units a completed
   * operation reports. Optional so a test double that only stubs phase/terminal does not have to grow a
   * method it never calls; every real operation provides it.
   */
  snapshotPhases?: () => string
  complete: (fields?: DiagnosticFields) => void
  cancel: (fields?: DiagnosticFields) => void
  fail: (error: unknown, fields?: DiagnosticFields) => void
}

export type DiagnosticOperationInput = {
  operation: string
  fields?: DiagnosticFields
  now?: () => number
  operationId?: string
}

const scalarFields = (fields: DiagnosticFields | undefined): DiagnosticFields => {
  try {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {}

    const safe: DiagnosticFields = Object.create(null) as DiagnosticFields
    for (const key of Object.keys(fields)) {
      let value: unknown
      try {
        value = (fields as Record<string, unknown>)[key]
      } catch {
        continue
      }
      if (
        value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        safe[key] = value as DiagnosticValue
      }
    }
    return safe
  } catch {
    return {}
  }
}

let fallbackOperationId = 0

const inputValue = (
  input: DiagnosticOperationInput,
  key: keyof DiagnosticOperationInput
): unknown => {
  try {
    return input[key]
  } catch {
    return undefined
  }
}

const createOperationId = (): string => {
  try {
    return randomUUID()
  } catch {
    fallbackOperationId += 1
    return `diagnostic-${fallbackOperationId}`
  }
}

const emitSafely = (
  logger: Logger,
  level: keyof Logger,
  message: string,
  data: Record<string, unknown>
): void => {
  try {
    logger[level](message, data)
  } catch {
    // Diagnostics must never alter the authoritative operation.
  }
}

export const startDiagnosticOperation = (
  logger: Logger,
  input: DiagnosticOperationInput
): DiagnosticOperation => {
  const rawOperation = inputValue(input, 'operation')
  const operation = typeof rawOperation === 'string' && rawOperation ? rawOperation : 'unknown'
  const rawOperationId = inputValue(input, 'operationId')
  const operationId =
    typeof rawOperationId === 'string' && rawOperationId ? rawOperationId : createOperationId()
  const rawNow = inputValue(input, 'now')
  const now = typeof rawNow === 'function' ? (rawNow as () => number) : Date.now
  const readNow = (): number => {
    try {
      const value = now()
      return Number.isFinite(value) ? value : 0
    } catch {
      return 0
    }
  }
  const startedAt = readNow()
  const baseFields = scalarFields(inputValue(input, 'fields') as DiagnosticFields | undefined)
  let latestPhase: string | undefined
  let terminal = false
  // Phases carry no timestamps of their own, so a slow startup could say *what* it did but never *where*
  // the seconds went. Recorded relative to the operation start and reported as one line on completion.
  //
  // The recorded number is a *start offset*, and it used to be reported under the bare name `phases`
  // (`transfer=1ms`). Read next to `durationMs`, that line said a 38-minute download had spent 1 ms in
  // `transfer` — it had spent 38 minutes there, and had merely *entered* the phase one millisecond in
  // (real record: durationMs 2,283,340 with `phases: "transfer=1ms"`). So each phase is now reported
  // twice, with names that cannot be mistaken for each other: `phaseDurations` (how long that phase ran,
  // ending where the next one began or where the operation ended) and `phaseStartedAtMs` (the offset).
  // `totalPhaseMs` is the sum of the durations — the span the named phases cover, which excludes any
  // time before the first phase.
  const phases: { name: string; atMs: number }[] = []
  const formatPhases = (endMs: number, value: 'duration' | 'offset'): string =>
    phases
      .map((entry, index) => {
        const next = phases[index + 1]
        const amount =
          value === 'offset'
            ? entry.atMs
            : Math.max(0, (next === undefined ? endMs : next.atMs) - entry.atMs)
        return `${entry.name}=${amount}ms`
      })
      .join(' ')

  const eventFields = (fields?: DiagnosticFields): Record<string, unknown> => ({
    ...baseFields,
    ...scalarFields(fields),
    operation,
    operationId
  })
  const finish = (
    level: keyof Logger,
    message: string,
    outcome: 'completed' | 'cancelled' | 'failed',
    fields?: DiagnosticFields,
    extraFields?: Record<string, unknown>
  ): void => {
    if (terminal) return
    terminal = true
    const durationMs = Math.max(0, readNow() - startedAt)
    const phaseDurations = phases.length === 0 ? undefined : formatPhases(durationMs, 'duration')
    emitSafely(logger, level, message, {
      ...eventFields(fields),
      ...(latestPhase === undefined ? {} : { phase: latestPhase }),
      ...(phaseDurations === undefined
        ? {}
        : {
            phaseDurations,
            phaseStartedAtMs: formatPhases(durationMs, 'offset'),
            totalPhaseMs: phases.reduce((sum, entry, index) => {
              const next = phases[index + 1]
              return sum + Math.max(0, (next === undefined ? durationMs : next.atMs) - entry.atMs)
            }, 0)
          }),
      outcome,
      durationMs,
      ...extraFields
    })
  }

  emitSafely(logger, 'info', 'operation started', {
    ...baseFields,
    operation,
    operationId,
    outcome: 'started'
  })

  return {
    phase: (name, fields) => {
      if (terminal) return
      const rawName = typeof name === 'string' && name ? name : 'unknown'
      latestPhase = rawName
      const atMs = Math.max(0, readNow() - startedAt)
      phases.push({ name: rawName, atMs })
      emitSafely(logger, 'info', 'operation phase', {
        ...eventFields(fields),
        phase: rawName,
        elapsedMs: atMs
      })
    },
    snapshotPhases: () => formatPhases(Math.max(0, readNow() - startedAt), 'duration'),
    complete: (fields) => finish('info', 'operation completed', 'completed', fields),
    cancel: (fields) => finish('warn', 'operation cancelled', 'cancelled', fields),
    fail: (error, fields) =>
      finish('error', 'operation failed', 'failed', fields, diagnosticErrorFields(error))
  }
}
