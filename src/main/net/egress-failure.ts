// Names for outbound failures. A bare `fetch failed` cannot be acted on: the machine's DNS not
// resolving a source, the source refusing the connection, a timeout, and the outbound allowlist
// blocking the destination all need different moves, yet they reached the log (and the agent) as one
// undifferentiated string. The proxy's HTTP path was worse — it answered a generic "target unreachable"
// while discarding the error entirely, so those failures left no trace at all.
//
// One vocabulary, used by three consumers so a failure reads the same wherever it surfaces:
//   * the filtering proxy's log line (child processes: agent CLI, notebook kernels, shells),
//   * the proxy's refusal body (what the client can see),
//   * the connector fetch boundary (main process, what the agent gets back from a tool call).
//
// Defensive on purpose, like `diagnosticErrorFields` in the logger: a code is only accepted when it
// looks like a system code, so a hostile `code`/`name` property cannot smuggle arbitrary text into a
// log or into an agent-visible message face.

export const EGRESS_FAILURE_FAMILIES = [
  'dns',
  'timeout',
  'refused',
  'reset',
  'unreachable',
  'tls',
  'blocked',
  'unknown'
] as const

export type EgressFailureFamily = (typeof EGRESS_FAILURE_FAMILIES)[number]

export type EgressFailure = {
  family: EgressFailureFamily
  // The system code that decided the family, or null when the family came from the message text (or
  // when the failure carried neither).
  code: string | null
  // What happened, in one English sentence fragment. English on purpose: this is read by the agent,
  // the log and support bundles, not by the interface — user-facing copy goes through the UI layer.
  reason: string
  // What the caller (or the agent) can do about it, so a retry is a decision rather than a reflex.
  action: string
}

const CODES_BY_FAMILY: Readonly<
  Record<Exclude<EgressFailureFamily, 'unknown'>, readonly string[]>
> = {
  dns: ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'ENODATA'],
  timeout: [
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'ECONNTIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET_TIMEOUT'
  ],
  refused: ['ECONNREFUSED'],
  reset: ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE'],
  unreachable: ['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ENETRESET', 'EADDRNOTAVAIL'],
  tls: [],
  blocked: []
}

const REASON_BY_FAMILY: Readonly<Record<EgressFailureFamily, string>> = {
  dns: 'the name did not resolve',
  timeout: 'the connection timed out',
  refused: 'the target refused the connection',
  reset: 'the connection was closed before an answer arrived',
  unreachable: 'there is no route to that host from this machine',
  tls: 'the TLS handshake failed',
  blocked: 'the outbound allowlist blocked this destination',
  unknown: 'the request failed without a recognised network code'
}

const ACTION_BY_FAMILY: Readonly<Record<EgressFailureFamily, string>> = {
  dns: 'Check this machine’s DNS or proxy for that host, or use a mirror of the source; repeating the same request will keep failing.',
  timeout:
    'Retry later or raise the timeout for this source; a repeated timeout means the path is slow or blocked, not busy.',
  refused:
    'The service is not accepting connections on that port — verify the endpoint, not the network.',
  reset:
    'The peer or a middlebox dropped the connection — retry once, then treat the source as unreachable.',
  unreachable:
    'No route from this machine to that host — check the network or proxy before retrying.',
  tls: 'The certificate or protocol was refused — check the system clock, proxy interception, or the endpoint.',
  blocked:
    'This destination is not on the outbound allowlist — ask the user to approve it instead of retrying.',
  unknown: 'Record the message and host; retrying without a named cause is a guess.'
}

const MAX_CODE_LENGTH = 64
const SYSTEM_CODE = /^(?:E[A-Z0-9_]+|ERR_[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|CERT_[A-Z0-9_]+)$/
const MAX_MESSAGE_LENGTH = 200

// Only identifier-shaped system codes are copied; anything else (a numeric RPC code, a sentence, a
// path) is dropped rather than carried into a log or an agent-visible message.
const safeCode = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > MAX_CODE_LENGTH) return null
  return SYSTEM_CODE.test(value) ? value : null
}

const safeText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > MAX_MESSAGE_LENGTH ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH)}…` : trimmed
}

const readField = (value: unknown, key: 'code' | 'name' | 'message' | 'cause'): unknown => {
  try {
    if (typeof value !== 'object' || value === null) return undefined
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

// The chain undici produces: `TypeError: fetch failed` whose `cause` is the socket error that carries
// the code. Walk it (bounded) so the innermost real code decides the family.
const errorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    chain.push(current)
    const next = readField(current, 'cause')
    if (next === undefined || next === null || chain.includes(next)) break
    current = next
  }
  return chain
}

const familyFromText = (text: string): EgressFailureFamily | null => {
  const lower = text.toLowerCase()
  if (
    /getaddrinfo|name or service not known|nodename nor servname|no address associated/.test(lower)
  ) {
    return 'dns'
  }
  if (/socket has been ended by the other party|socket hang up|premature close/.test(lower)) {
    return 'reset'
  }
  // Our own proxy's refusals: the allowlist decision is not a network failure and must not be read as
  // one — a user can lift it, a broken DNS cannot.
  if (/allowlist|host not permitted|proxy response \(403\)/.test(lower)) return 'blocked'
  if (/timed? ?out|timeout/.test(lower)) return 'timeout'
  if (/econnrefused/.test(lower)) return 'refused'
  if (/econnreset|epipe|econnaborted/.test(lower)) return 'reset'
  if (/enetunreach|ehostunreach|enetdown|eaddrnotavail/.test(lower)) return 'unreachable'
  if (
    /certificate|self[- ]signed|unable to verify|wrong version number|\btls\b|\bssl\b/.test(lower)
  ) {
    return 'tls'
  }
  return null
}

const familyForCode = (code: string): EgressFailureFamily | null => {
  for (const [family, codes] of Object.entries(CODES_BY_FAMILY)) {
    if (codes.includes(code)) return family as EgressFailureFamily
  }
  if (code.startsWith('CERT_') || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL'))
    return 'tls'
  return null
}

// Describes one outbound failure. Never throws, never returns an empty reason: an unrecognised failure
// still gets the family `unknown` plus whatever description the error carried, because "we could not
// name it" and "nothing happened" must not read the same.
export const describeEgressFailure = (error: unknown): EgressFailure => {
  try {
    const chain = errorChain(error)
    const codes = chain
      .map((entry) => safeCode(readField(entry, 'code')))
      .filter((code): code is string => code !== null)
    for (const code of codes) {
      const family = familyForCode(code)
      if (family) {
        return { family, code, reason: REASON_BY_FAMILY[family], action: ACTION_BY_FAMILY[family] }
      }
    }

    const names = chain
      .map((entry) => safeText(readField(entry, 'name')))
      .filter((name): name is string => name !== null)
    if (names.includes('TimeoutError') || names.includes('AbortError')) {
      return {
        family: 'timeout',
        code: null,
        reason: REASON_BY_FAMILY.timeout,
        action: ACTION_BY_FAMILY.timeout
      }
    }

    const messages = chain
      .map((entry) => safeText(readField(entry, 'message')))
      .filter((message): message is string => message !== null)
    // A rejection may be a bare string (a transport that rejects with text, not an Error): the string
    // IS the description, so it is classified like any message.
    if (typeof error === 'string') {
      const asText = safeText(error)
      if (asText !== null) messages.push(asText)
    }
    for (const message of messages) {
      const family = familyFromText(message)
      if (family) {
        return {
          family,
          code: null,
          reason: REASON_BY_FAMILY[family],
          action: ACTION_BY_FAMILY[family]
        }
      }
    }

    const described = messages[0] ?? null
    return {
      family: 'unknown',
      code: codes[0] ?? null,
      reason: described
        ? `${REASON_BY_FAMILY.unknown} (${described})`
        : `${REASON_BY_FAMILY.unknown} — the failure carried no description`,
      action: ACTION_BY_FAMILY.unknown
    }
  } catch {
    return {
      family: 'unknown',
      code: null,
      reason: `${REASON_BY_FAMILY.unknown} — the error could not be inspected`,
      action: ACTION_BY_FAMILY.unknown
    }
  }
}

// One line that names the failure and the target, for a log record or an agent-visible message.
export const formatEgressFailure = (failure: EgressFailure, target?: string): string => {
  const where = target ? ` reaching ${target}` : ''
  const code = failure.code ? ` (${failure.code})` : ''
  return `egress ${failure.family} failure${where}: ${failure.reason}${code}. ${failure.action}`
}

// Wraps a failed fetch into an error whose message names the family and keeps the original message
// (verbatim, so existing matchers such as `/fetch failed/` still hold) — this is what the agent sees
// when a connector call fails, instead of a bare `fetch failed`.
export const annotateEgressFailure = (error: unknown, target: string): Error => {
  const failure = describeEgressFailure(error)
  const original = error instanceof Error ? error.message : safeText(error)
  const head = original ? `${original} — ` : ''
  const annotated = new Error(`${head}${formatEgressFailure(failure, target)}`, {
    cause: error instanceof Error ? error : undefined
  })
  return annotated
}
