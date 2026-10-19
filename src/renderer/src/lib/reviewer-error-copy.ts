// Turns a failed review's persisted `errorMessage` into a family the panel can explain in the reader's
// own language.
//
// Why this exists: the card used to open straight onto whatever the failing layer wrote — in the field
// that was a Prisma dump naming an absolute path inside the packaged app and quoting the SQL call that
// expired ("Invalid `tx.review.update()` invocation in /Applications/…/ipc-CLnmvMls.js:2029:23 …
// Transaction already closed: … The timeout for this transaction was 5000 ms"). A reader of a review
// panel is being told whether the turn was checked; that is not the place to hand them an ORM stack.
//
// The matchers below quote the strings the producers in this app actually emit (orchestrator, review
// repository, agent runtime, provider envelope). A message this module does not recognise stays
// `unknown`: the panel then says only that it does not know the cause and shows the raw text — it never
// guesses one, and nothing is ever hidden.
export type ReviewErrorFamily =
  'persistence' | 'storage' | 'protocol' | 'provider' | 'runtime' | 'timeout' | 'unknown'

type Matcher = { family: ReviewErrorFamily; needles: readonly string[] }

// Order is the contract: a persistence failure's own text says "The timeout for this transaction was
// 5000 ms", so the persistence matchers must run before the timeout ones, and a snapshot-write failure
// (storage) is a different loss from a verdict that never got committed (persistence).
const MATCHERS: readonly Matcher[] = [
  {
    family: 'persistence',
    // Observed verbatim in the installed app's database:
    //   Invalid `tx.review.update()` invocation in /Applications/…/out/main/ipc-*.js:2029:23 …
    //   Transaction API error: Transaction already closed: A query cannot be executed on an expired
    //   transaction. The timeout for this transaction was 5000 ms, however 6692 ms passed…
    needles: [
      'Invalid `tx.',
      'Transaction already closed',
      'Transaction API error',
      'Unable to start a transaction',
      'database is locked',
      'PrismaClientKnownRequestError'
    ]
  },
  {
    family: 'storage',
    // ReviewRepository.persistScopeSnapshot: 'Review scope snapshot storage is not configured.' and the
    // filesystem errors a failed snapshot write can raise.
    needles: ['scope snapshot', 'ENOSPC', 'EACCES', 'EPERM']
  },
  {
    family: 'protocol',
    // Observed: 'Reviewer stopped without calling submit_findings.' (and the permission-gate variant),
    // plus the bridge-scope refusal REVIEWER_BRIDGE_SCOPE_ERROR.
    needles: ['submit_findings', 'reviewer-only tool scope']
  },
  {
    family: 'provider',
    // Observed: 'Internal error: API Error: 402 Insufficient Balance (request_id: …)' — the model
    // provider answered and refused, so the review itself never started.
    needles: [
      'Insufficient Balance',
      'API Error: 401',
      'API Error: 402',
      'API Error: 403',
      'API Error: 429',
      'Authentication required',
      'authentication_error',
      'rate limit'
    ]
  },
  {
    family: 'runtime',
    // Observed: 'ACP connection closed' (twice in the field), plus the transport-level failures the ACP
    // client surfaces when the agent process goes away mid-review.
    needles: ['ACP connection closed', 'ACP connection', 'socket hang up', 'ECONNRESET']
  },
  {
    family: 'timeout',
    // Observed in the development instance: 'reviewer session timed out before stopping'.
    needles: ['timed out before stopping', 'reviewer session timed out']
  }
]

export const classifyReviewError = (message: string | undefined): ReviewErrorFamily => {
  if (!message) return 'unknown'
  const haystack = message.toLowerCase()
  for (const matcher of MATCHERS) {
    if (matcher.needles.some((needle) => haystack.includes(needle.toLowerCase()))) {
      return matcher.family
    }
  }
  return 'unknown'
}

// The one-sentence explanation shown at the top of an expanded error card (and the short state word
// appended to the collapsed status line). Both live in the nine-language dictionary; the panel never
// composes user-facing prose itself.
// Template-literal return types so the panel can hand these straight to `t()`, which only accepts keys
// the dictionaries declare — a family added without its nine translations then fails to compile instead
// of putting a raw key on screen.
export type ReviewErrorCopyKey = `reviewer.error.${ReviewErrorFamily}`
export type ReviewErrorShortKey = `reviewer.errorShort.${ReviewErrorFamily}`

export const reviewErrorCopyKey = (family: ReviewErrorFamily): ReviewErrorCopyKey =>
  `reviewer.error.${family}`

export const reviewErrorShortKey = (family: ReviewErrorFamily): ReviewErrorShortKey =>
  `reviewer.errorShort.${family}`
