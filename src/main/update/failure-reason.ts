// Names an update failure for the reader who is looking at the dialog.
//
// Two vocabularies already exist in this area and neither answers "what should the reader do":
//   * `describeUpdateFailure` (manifest.ts) is a LOG vocabulary — `transport` / `unclassified` are useful
//     when reading a failure line and useless on screen;
//   * `describeEgressFailure` (net/egress-failure.ts) names node-shaped failures for the log and the
//     agent, in English, on purpose.
// So this module classifies the same error into the closed `UpdateFailureReason` set the interface can
// translate, and it does so by REUSING those two rather than inventing a third opinion about node codes.
//
// The one thing it adds is the Chromium token table: electron-updater reports transport failures as
// `net::ERR_*` inside the message, and neither existing classifier maps those tokens to a family. The
// tokens below mirror the closed table the logger already keeps (`logger.ts`, `netErrorCategories`) plus
// the three families the log had no reason to distinguish (refused/reset/tls are all `network` there).
// Keeping the mirrored entries in step matters: a token that falls through lands as `unknown`, which shows
// the reader the raw message — the state this module exists to remove.
import type { UpdateFailureReason } from '../../shared/update'
import { describeEgressFailure, type EgressFailureFamily } from '../net/egress-failure'

const NET_TOKEN = /net::(ERR_[A-Z0-9_]{3,40})/
/** How much of one message is scanned: a hostile getter should stay cheap, and tokens appear early. */
const SCAN_WINDOW = 400
const MAX_CHAIN = 5

const TOKEN_REASONS: Readonly<Record<string, UpdateFailureReason>> = {
  ERR_NAME_NOT_RESOLVED: 'dns',
  ERR_NAME_RESOLUTION_FAILED: 'dns',
  ERR_INTERNET_DISCONNECTED: 'offline',
  ERR_NETWORK_CHANGED: 'network-changed',
  ERR_NETWORK_IO_SUSPENDED: 'network-changed',
  ERR_CONNECTION_REFUSED: 'refused',
  ERR_CONNECTION_RESET: 'reset',
  ERR_CONNECTION_CLOSED: 'reset',
  ERR_CONNECTION_ABORTED: 'reset',
  ERR_EMPTY_RESPONSE: 'reset',
  ERR_TIMED_OUT: 'timeout',
  ERR_CONNECTION_TIMED_OUT: 'timeout'
}

const EGRESS_REASONS: Readonly<Record<EgressFailureFamily, UpdateFailureReason>> = {
  dns: 'dns',
  timeout: 'timeout',
  refused: 'refused',
  reset: 'reset',
  // "No route to that host" is, from where the reader sits, "this machine is not on the network".
  unreachable: 'offline',
  tls: 'tls',
  // The outbound allowlist belongs to child processes; an update request never travels through it, so a
  // refusal that names it did not come from the update path. Say we do not know rather than guess.
  blocked: 'unknown',
  unknown: 'unknown'
}

const readString = (value: unknown, key: string): string | null => {
  try {
    if (typeof value !== 'object' || value === null) return null
    const field = (value as Record<string, unknown>)[key]
    return typeof field === 'string' ? field : null
  } catch {
    return null
  }
}

const readHttpStatus = (value: unknown): number | null => {
  for (const key of ['statusCode', 'status']) {
    try {
      if (typeof value !== 'object' || value === null) continue
      const field = (value as Record<string, unknown>)[key]
      if (typeof field === 'number' && Number.isInteger(field) && field >= 100 && field <= 599) {
        return field
      }
    } catch {
      // A throwing getter is not a status.
    }
  }
  try {
    if (typeof value === 'object' && value !== null) {
      return readHttpStatus((value as Record<string, unknown>).response)
    }
  } catch {
    return null
  }
  return null
}

// The chain undici/electron produce: a wrapper whose `cause` carries the socket error. Bounded, and it
// stops on a cycle so a self-referencing error cannot spin here.
const errorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = []
  let current: unknown = error
  for (let depth = 0; depth < MAX_CHAIN && current !== undefined && current !== null; depth += 1) {
    if (chain.includes(current)) break
    chain.push(current)
    current = typeof current === 'object' ? safeCause(current) : undefined
  }
  return chain
}

const safeCause = (value: object): unknown => {
  try {
    return (value as Record<string, unknown>).cause
  } catch {
    return undefined
  }
}

const reasonFromToken = (message: string): UpdateFailureReason | null => {
  const match = NET_TOKEN.exec(message.slice(0, SCAN_WINDOW))
  if (!match) return null
  const token = match[1]!
  const named = TOKEN_REASONS[token]
  if (named) return named
  // A certificate token the table does not list is still a certificate failure; any other Chromium code
  // is a network failure this module cannot name more precisely.
  if (
    token.startsWith('ERR_CERT_') ||
    token.startsWith('ERR_SSL_') ||
    token.startsWith('ERR_TLS')
  ) {
    return 'tls'
  }
  return 'unknown'
}

/**
 * Classifies an update failure into the closed set the dialog translates.
 *
 * Never throws: a hostile getter, a non-error rejection or a missing error all land on `unknown`, which
 * is the honest reading ("this app could not name it") rather than a family picked by guessing.
 */
export const describeUpdateFailureReason = (error: unknown): UpdateFailureReason => {
  try {
    const chain = errorChain(error)

    // An HTTP answer is the most specific thing an error can carry: the server was reached and said no.
    if (chain.some((entry) => readHttpStatus(entry) !== null)) return 'http'

    const names = chain.map((entry) => readString(entry, 'name')).filter((name) => name !== null)
    if (names.includes('TimeoutError') || names.includes('AbortError')) return 'timeout'

    for (const entry of chain) {
      const message = readString(entry, 'message')
      if (message === null) continue
      const fromToken = reasonFromToken(message)
      if (fromToken !== null) return fromToken
    }
    // A transport that rejects with text rather than an Error: the string IS the description.
    if (typeof error === 'string') {
      const fromToken = reasonFromToken(error)
      if (fromToken !== null) return fromToken
    }

    return EGRESS_REASONS[describeEgressFailure(error).family]
  } catch {
    return 'unknown'
  }
}
