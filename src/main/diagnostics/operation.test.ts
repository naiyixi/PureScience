import { describe, expect, it } from 'vitest'

import type { Logger } from '../logger'
import {
  type DiagnosticFields,
  type DiagnosticOperationInput,
  startDiagnosticOperation
} from './operation'

type CapturedRecord = {
  level: keyof Logger
  message: string
  data: unknown
}

const createRecordingLogger = (): { logger: Logger; records: CapturedRecord[] } => {
  const records: CapturedRecord[] = []
  const capture =
    (level: keyof Logger) =>
    (message: string, data?: unknown): void => {
      records.push({ level, message, data })
    }

  return {
    logger: {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error')
    },
    records
  }
}

describe('diagnostic operation', () => {
  it('starts once with a stable operation ID and scalar context', () => {
    const { logger, records } = createRecordingLogger()

    startDiagnosticOperation(logger, {
      operation: 'data-root-migration',
      operationId: 'migration-1',
      fields: { source: 'legacy', retry: false }
    })

    expect(records).toEqual([
      {
        level: 'info',
        message: 'operation started',
        data: {
          source: 'legacy',
          retry: false,
          operation: 'data-root-migration',
          operationId: 'migration-1',
          outcome: 'started'
        }
      }
    ])
  })

  it('records a phase with the operation context', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 40
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-migration',
      operationId: 'migration-1',
      fields: { source: 'legacy' },
      now: () => timestamp
    })

    timestamp = 52
    operation.phase('copy', { filesCopied: 3 })

    expect(records[1]).toEqual({
      level: 'info',
      message: 'operation phase',
      data: {
        source: 'legacy',
        filesCopied: 3,
        operation: 'data-root-migration',
        operationId: 'migration-1',
        phase: 'copy',
        elapsedMs: 12
      }
    })
  })

  it('completes with duration and the latest phase', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 100
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-migration',
      operationId: 'migration-1',
      fields: { source: 'legacy' },
      now: () => timestamp
    })
    operation.phase('verify-target')

    timestamp = 145
    operation.complete({ filesCopied: 3 })

    expect(records[2]).toEqual({
      level: 'info',
      message: 'operation completed',
      data: {
        source: 'legacy',
        filesCopied: 3,
        operation: 'data-root-migration',
        operationId: 'migration-1',
        phase: 'verify-target',
        phaseDurations: 'verify-target=45ms',
        phaseStartedAtMs: 'verify-target=0ms',
        totalPhaseMs: 45,
        outcome: 'completed',
        durationMs: 45
      }
    })
  })

  // The real record this guards: `update-download` finished after 2,283,340 ms and logged
  // `phases: "transfer=1ms"` — the phase had *started* 1 ms in and lasted the whole 38 minutes. A reader
  // (and this repository's own defect triage) took that as "transfer took 1 ms".
  it('reports how long each phase ran, not the offset where it began', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 1_000
    const operation = startDiagnosticOperation(logger, {
      operation: 'update-download',
      operationId: 'update-2',
      now: () => timestamp
    })

    timestamp = 1_001
    operation.phase('transfer')

    timestamp = 2_284_340
    operation.fail(new Error('socket closed'))

    expect(records[2].data).toMatchObject({
      phase: 'transfer',
      phaseDurations: 'transfer=2283339ms',
      phaseStartedAtMs: 'transfer=1ms',
      totalPhaseMs: 2_283_339,
      durationMs: 2_283_340
    })
  })

  it('ends each phase where the next one begins and sums the durations', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 0
    const operation = startDiagnosticOperation(logger, {
      operation: 'update-download',
      operationId: 'update-3',
      now: () => timestamp
    })

    operation.phase('transfer')
    timestamp = 500
    operation.phase('verify')
    timestamp = 600
    operation.complete()

    const data = records[records.length - 1]!.data as Record<string, unknown>
    expect(data.phaseDurations).toBe('transfer=500ms verify=100ms')
    expect(data.phaseStartedAtMs).toBe('transfer=0ms verify=500ms')
    // The sum is the span the named phases cover, and equals the operation duration when the first phase
    // starts at zero — never "where the last phase started".
    expect(data.totalPhaseMs).toBe(600)
    expect(data.totalPhaseMs).toBe(data.durationMs)
  })

  it('does not count the time before the first phase as phase time', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 0
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-migration',
      operationId: 'migration-2',
      now: () => timestamp
    })

    timestamp = 200
    operation.phase('copy')
    timestamp = 300
    operation.complete()

    const data = records[records.length - 1]!.data as Record<string, unknown>
    expect(data.phaseDurations).toBe('copy=100ms')
    expect(data.phaseStartedAtMs).toBe('copy=200ms')
    expect(data.totalPhaseMs).toBe(100)
    expect(data.durationMs).toBe(300)
  })

  it('snapshots each phase duration up to this moment for an operation that never completes', () => {
    const { logger } = createRecordingLogger()
    let timestamp = 0
    const operation = startDiagnosticOperation(logger, {
      operation: 'startup',
      operationId: 'startup-2',
      now: () => timestamp
    })

    operation.phase('load-bootstrap-modules')
    timestamp = 811
    operation.phase('external-mcp-started')
    timestamp = 900

    expect(operation.snapshotPhases?.()).toBe(
      'load-bootstrap-modules=811ms external-mcp-started=89ms'
    )
  })

  it('fails with a coarse error category and no raw error payload', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 10
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-migration',
      operationId: 'migration-1',
      now: () => timestamp
    })
    operation.phase('copy')

    timestamp = 34
    operation.fail(
      Object.assign(new Error('secret target path'), {
        code: 'EACCES',
        path: '/private/secret'
      }),
      { recoverable: true }
    )

    expect(records[2]).toEqual({
      level: 'error',
      message: 'operation failed',
      data: {
        recoverable: true,
        operation: 'data-root-migration',
        operationId: 'migration-1',
        phase: 'copy',
        phaseDurations: 'copy=24ms',
        phaseStartedAtMs: 'copy=0ms',
        totalPhaseMs: 24,
        outcome: 'failed',
        durationMs: 24,
        errorCategory: 'permission'
      }
    })
    expect(JSON.stringify(records[2])).not.toContain('secret')
  })

  it('emits at most one terminal record and ignores every call after it', () => {
    const { logger, records } = createRecordingLogger()
    const operation = startDiagnosticOperation(logger, {
      operation: 'update-check',
      operationId: 'update-1',
      now: () => 10
    })

    operation.complete()
    operation.phase('late-phase')
    operation.complete()
    operation.cancel()
    operation.fail(new Error('late failure'))

    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      message: 'operation completed',
      data: { outcome: 'completed' }
    })
  })

  it('records cancellation separately from failure', () => {
    const { logger, records } = createRecordingLogger()
    let timestamp = 20
    const operation = startDiagnosticOperation(logger, {
      operation: 'update-download',
      operationId: 'update-1',
      now: () => timestamp
    })
    operation.phase('download')

    timestamp = 32
    operation.cancel({ requestedByUser: true })

    expect(records[2]).toEqual({
      level: 'warn',
      message: 'operation cancelled',
      data: {
        requestedByUser: true,
        operation: 'update-download',
        operationId: 'update-1',
        phase: 'download',
        phaseDurations: 'download=12ms',
        phaseStartedAtMs: 'download=0ms',
        totalPhaseMs: 12,
        outcome: 'cancelled',
        durationMs: 12
      }
    })
  })

  it('keeps only scalar fields and protects diagnostic-owned fields', () => {
    const { logger, records } = createRecordingLogger()

    startDiagnosticOperation(logger, {
      operation: 'session-hydration',
      operationId: 'session-1',
      fields: {
        safe: 'kept',
        operation: 'spoofed',
        nested: { research: 'private' },
        list: ['private']
      } as unknown as DiagnosticFields
    })

    expect(records[0].data).toEqual({
      safe: 'kept',
      operation: 'session-hydration',
      operationId: 'session-1',
      outcome: 'started'
    })
  })

  it('sanitizes scalar fields supplied to phase and terminal calls', () => {
    const { logger, records } = createRecordingLogger()
    const operation = startDiagnosticOperation(logger, {
      operation: 'update-check',
      operationId: 'update-1',
      now: () => 5
    })

    operation.phase('checking', {
      scalar: 1,
      phase: 'spoofed',
      nested: { secret: true }
    } as unknown as DiagnosticFields)
    operation.complete({
      result: true,
      outcome: 'spoofed',
      nested: { secret: true }
    } as unknown as DiagnosticFields)

    expect(records[1].data).toEqual({
      scalar: 1,
      operation: 'update-check',
      operationId: 'update-1',
      phase: 'checking',
      elapsedMs: 0
    })
    expect(records[2].data).toEqual({
      result: true,
      operation: 'update-check',
      operationId: 'update-1',
      phase: 'checking',
      phaseDurations: 'checking=0ms',
      phaseStartedAtMs: 'checking=0ms',
      totalPhaseMs: 0,
      outcome: 'completed',
      durationMs: 0
    })
  })

  it('never throws when the diagnostic clock or sink fails', () => {
    const throwFromSink = (): never => {
      throw new Error('sink unavailable')
    }
    const logger: Logger = {
      debug: throwFromSink,
      info: throwFromSink,
      warn: throwFromSink,
      error: throwFromSink
    }
    let operation: ReturnType<typeof startDiagnosticOperation> | undefined

    expect(() => {
      operation = startDiagnosticOperation(logger, {
        operation: 'startup',
        operationId: 'startup-1',
        now: () => {
          throw new Error('clock unavailable')
        }
      })
    }).not.toThrow()

    expect(() => operation?.phase('compose')).not.toThrow()
    expect(() => operation?.complete()).not.toThrow()
    expect(() => operation?.cancel()).not.toThrow()
    expect(() => operation?.fail(new Error('authoritative failure'))).not.toThrow()
  })

  it('never throws when the operation input has hostile property access', () => {
    const { logger } = createRecordingLogger()
    const hostileInput = new Proxy({} as DiagnosticOperationInput, {
      get() {
        throw new Error('input getter failed')
      }
    })
    let operation: ReturnType<typeof startDiagnosticOperation> | undefined

    expect(() => {
      operation = startDiagnosticOperation(logger, hostileInput)
    }).not.toThrow()
    expect(() => operation?.phase('fallback')).not.toThrow()
    expect(() => operation?.fail(new Error('original failure'))).not.toThrow()
  })
})
