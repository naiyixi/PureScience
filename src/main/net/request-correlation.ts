import { randomUUID } from 'node:crypto'

import { createLogger } from '../logger'

// Correlated HTTP request diagnostics: every outbound web request gets a
// correlation id that ties command, session, and run logs together. The id travels as an
// `x-request-id` header so server-side logs can join the same trace, and is logged locally with the
// request outcome so app logs can be filtered by one id.

const log = createLogger('http-request')

export const CORRELATION_ID_HEADER = 'x-request-id'

const newCorrelationId = (): string => `req-${randomUUID().slice(0, 8)}`

// Wraps a fetch implementation so each call is tagged with a fresh correlation id, logged with its
// outcome, and carries the id header to the peer. Swallows nothing: request errors propagate
// unchanged (the error is logged with the id first).
export const withCorrelatedFetch = <Fetch extends (...args: never[]) => Promise<unknown>>(
  fetchImpl: Fetch
): Fetch =>
  ((...args) => {
    const correlationId = newCorrelationId()
    const url = String(args[0] ?? '')
    const init = (args[1] ?? {}) as { headers?: Record<string, string> | HeadersInit }
    const headers: Record<string, string> = {
      ...(typeof init.headers === 'object' && !Array.isArray(init.headers)
        ? (init.headers as Record<string, string>)
        : {}),
      [CORRELATION_ID_HEADER]: correlationId
    }
    const taggedArgs = [args[0], { ...init, headers }]

    return Promise.resolve(fetchImpl(...(taggedArgs as never[]))).then(
      (result) => {
        const response = result as { status?: number }
        log.info(`${correlationId} ${url} -> ${response.status ?? 'completed'}`)
        return result
      },
      (error: unknown) => {
        log.warn(`${correlationId} ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    )
  }) as Fetch
