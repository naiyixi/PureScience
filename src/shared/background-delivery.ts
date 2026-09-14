// Background execution results, and the ledger that gets them back into the session.
//
// The renderer already turns a finished compute job into an analysis prompt, which means a result only
// lands when a window is alive to notice it. This contract describes a delivery as a main-process record
// with its own state machine, a claim that survives a crash, and a fingerprint so anyone holding the
// output can check that the delivered result is the one that was produced.
//
// Nothing here touches node:crypto — this module is shared with the renderer, which never hashes.

export const BACKGROUND_DELIVERY_SCHEMA_VERSION = 1

// Published so a delivery's result fingerprint can be recomputed outside the app: sha256 over these
// lines, in this order, each terminated by "\n" (the last one included).
export const BACKGROUND_DELIVERY_HASH_RECIPE = 'purescience-background-delivery-v1'

export type BackgroundDeliverySourceKind = 'compute' | 'notebook'

// The delivery state machine:
//   waiting-result  the job has not finished; there is nothing to deliver yet
//   pending         a result exists and is queued for delivery into the session
//   claimed         a worker holds it; the claim expires so a crash cannot strand it
//   dispatching     the continuation turn is being written
//   consumed        the turn is in the session (terminal)
//   needs-attention a result exists but cannot be delivered — never dropped silently, and never
//                   replaced by an invented analysis
export type BackgroundDeliveryState =
  'waiting-result' | 'pending' | 'claimed' | 'dispatching' | 'consumed' | 'needs-attention'

export const BACKGROUND_DELIVERY_STATES: readonly BackgroundDeliveryState[] = [
  'waiting-result',
  'pending',
  'claimed',
  'dispatching',
  'consumed',
  'needs-attention'
]

// States a delivery can still be consumed from. 'consumed' is terminal; 'waiting-result' has no
// result to deliver yet.
export const BACKGROUND_DELIVERY_CONSUMABLE_STATES: readonly BackgroundDeliveryState[] = [
  'pending',
  'claimed',
  'dispatching',
  'needs-attention'
]

// Why a delivery could not be delivered, or could not be claimed. Always named, never a bare boolean.
export type BackgroundDeliveryReason =
  // No job with that id.
  | 'job-not-found'
  // The job belongs to a different session than the delivery names.
  | 'session-mismatch'
  // The session the result belongs to could not be read, so there is nowhere to put it.
  | 'session-unavailable'
  // The delivery is already consumed, or has no result yet.
  | 'not-consumable'
  // Another worker holds a live claim.
  | 'claim-held'
  // The job finished but its output could not be read; the delivery goes to needs-attention.
  | 'result-unreadable'

export type BackgroundDelivery = {
  schemaVersion: typeof BACKGROUND_DELIVERY_SCHEMA_VERSION
  id: string
  projectId: string
  sessionId: string
  jobId: string
  sourceKind: BackgroundDeliverySourceKind
  state: BackgroundDeliveryState
  // Workspace-relative paths of the produced files, as recorded when the result was seen.
  outputFiles: readonly string[]
  // sha256 of the produced result, per the published recipe. Absent while there is nothing to hash.
  fingerprint: string | undefined
  // Live claim: only the holder may move the delivery, and only until the lease expires.
  claimToken: string | undefined
  claimExpiresAt: number | undefined
  // The continuation turn written into the session when the delivery landed.
  continuationMessageId: string | undefined
  // Present when the state is 'needs-attention': the named reason it could not be delivered.
  reason: BackgroundDeliveryReason | undefined
  createdAt: number
  updatedAt: number
  consumedAt: number | undefined
}

// A claim is live only while its lease holds. An expired claim is nobody's, which is what lets a
// crashed worker's deliveries be taken over instead of being stranded.
export const isBackgroundDeliveryClaimLive = (
  delivery: Pick<BackgroundDelivery, 'claimToken' | 'claimExpiresAt'>,
  now: number
): boolean =>
  delivery.claimToken !== undefined &&
  delivery.claimExpiresAt !== undefined &&
  delivery.claimExpiresAt > now

export const isBackgroundDeliveryConsumable = (delivery: BackgroundDelivery): boolean =>
  BACKGROUND_DELIVERY_CONSUMABLE_STATES.includes(delivery.state)

export type BackgroundDeliveryClaimResult =
  | { status: 'claimed'; delivery: BackgroundDelivery; claimToken: string }
  | { status: 'rejected'; reason: BackgroundDeliveryReason }

export type BackgroundDeliveryConsumeResult =
  | { status: 'consumed'; delivery: BackgroundDelivery }
  | { status: 'rejected'; reason: BackgroundDeliveryReason }

// The delivered result, as it is recorded on the message that carries it into the session. Structured
// rather than prose so the UI renders its own wording in its own language, and so a delivery can be
// recognised after a restart — which is what keeps a worker that died mid-delivery from writing twice.
export type BackgroundDeliveryRef = {
  deliveryId: string
  jobId: string
  sourceKind: BackgroundDeliverySourceKind
  outputFiles: readonly string[]
  fingerprint: string | undefined
  reason: BackgroundDeliveryReason | undefined
}

// Main has no UI language, so the text it writes into the session carries neutral wording; the UI renders
// its own localized prose from the structured ref above. Callers may pass their own labels instead of
// this set — this one exists so the fallback is explicit rather than accidental.
export const NEUTRAL_BACKGROUND_DELIVERY_LABELS: BackgroundDeliveryLabels = {
  header: 'Background result delivery',
  state: 'State',
  stateNames: {
    'waiting-result': 'waiting for the result',
    pending: 'ready to deliver',
    claimed: 'being delivered',
    dispatching: 'being delivered',
    consumed: 'delivered',
    'needs-attention': 'needs attention'
  },
  job: 'Job',
  files: 'Files',
  fingerprint: 'Fingerprint',
  reason: 'Reason',
  reasonNames: {
    'job-not-found': 'no such job',
    'session-mismatch': 'the job belongs to another session',
    'session-unavailable': 'the session could not be read',
    'not-consumable': 'there is nothing to deliver yet',
    'claim-held': 'another worker is delivering it',
    'result-unreadable': 'the result could not be read'
  },
  continuation: 'A background job has finished. Its recorded result is attached to this turn.',
  noResult: 'No result was produced'
}

export type BackgroundDeliveryLabels = {
  header: string
  state: string
  stateNames: Record<BackgroundDeliveryState, string>
  job: string
  files: string
  fingerprint: string
  reason: string
  reasonNames: Record<BackgroundDeliveryReason, string>
  continuation: string
  noResult: string
}

// One pasteable line per delivery. Labels follow the UI language; ids, paths and the fingerprint do
// not translate, because the point of the line is that someone else can check it.
export const formatBackgroundDeliveryLine = (
  delivery: BackgroundDelivery,
  labels: BackgroundDeliveryLabels
): string =>
  [
    `${labels.header}: ${delivery.id} (${labels.stateNames[delivery.state]})`,
    `${labels.job}: ${delivery.jobId} (${delivery.sourceKind})`,
    `${labels.files}: ${delivery.outputFiles.length > 0 ? delivery.outputFiles.join(', ') : '—'}`,
    `${labels.fingerprint}: ${delivery.fingerprint ?? '—'}`,
    ...(delivery.reason ? [`${labels.reason}: ${labels.reasonNames[delivery.reason]}`] : [])
  ].join('\n')

// The turn the session receives when results land. Results that could not be read are stated as such:
// the honest outcome is "no result, here is why", never an analysis of something we never saw.
//
// Which of the two a delivery is comes from its reason, not its state: the state tracks delivery
// progress, and a claimed delivery is still a delivery that has no result to show.
export const buildBackgroundDeliveryContinuation = (
  deliveries: readonly BackgroundDelivery[],
  labels: BackgroundDeliveryLabels
): string => {
  const deliverable = deliveries.filter((delivery) => delivery.reason === undefined)
  const blocked = deliveries.filter((delivery) => delivery.reason !== undefined)

  const blocks = deliverable.map((delivery) => {
    const lines = [
      `- ${labels.job}: ${delivery.jobId} (${delivery.sourceKind})`,
      `  ${labels.files}: ${delivery.outputFiles.length > 0 ? delivery.outputFiles.join(', ') : '—'}`,
      `  ${labels.fingerprint}: ${delivery.fingerprint ?? '—'}`
    ]
    return lines.join('\n')
  })

  const blockedBlocks = blocked.map(
    (delivery) =>
      `- ${labels.job}: ${delivery.jobId} — ${labels.noResult}: ${
        delivery.reason ? labels.reasonNames[delivery.reason] : '—'
      }`
  )

  return [labels.continuation, ...blocks, ...blockedBlocks].join('\n')
}
