// Fetch-domain authorization (D6).
//
// Provider-native web fetches used to be one-shot by design, and the recorded friction was real: the
// same host asked again and again inside one session (pmc.ncbi.nlm.nih.gov five times, a patents site
// five, patents.google.com four). A fetch, unlike a search, targets one host, so "allow this host for
// this session" is a scope a user can actually reason about — and it stays revocable.
//
// Scope decisions, both measured against those 27 recorded authorizations:
//   * Exact host, not the registrable parent: collapsing by parent saved exactly one more prompt while
//     broadening the grant to every sibling subdomain, which is not a trade worth making silently.
//   * A leading `www.` is dropped, so www.example.com and example.com are one grant.
//   * Anything unparseable yields no key, which leaves the request one-shot (fail closed) — a grant is
//     only ever created from a host we could actually read.
//
// WebSearch deliberately stays one-shot: a search reaches a service, not a site, so a host grant for it
// would mean nothing to the user.

export const FETCH_HOST_KEY_PREFIX = 'fetch-host:'

// The durable capability a fetch-host grant persists as. `capability.ts` treated provider-native web
// tools as non-persistable ("V1 has no persistable built-in provider tools") until an explicit
// registration existed — this is that registration, scoped to one host.
export const FETCH_PERMISSION_CAPABILITY_KEY = 'builtin/webfetch'

/** Lowercased host with a leading `www.` removed; undefined when the value is not a usable web URL. */
export const fetchHostFromUrl = (value: string): string | undefined => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  // A bare label (no dot) is not a site we can scope a grant to; localhost has no third party to leak to.
  if (!host.includes('.') && host !== 'localhost') return undefined
  return host.length > 0 ? host : undefined
}

/** The remembered-scope key for a fetch host. */
export const fetchHostCategoryKey = (host: string): string => `${FETCH_HOST_KEY_PREFIX}${host}`

/** The host back out of a key, or undefined when the key is not a fetch-host key. */
export const fetchHostFromCategoryKey = (categoryKey: string): string | undefined =>
  categoryKey.startsWith(FETCH_HOST_KEY_PREFIX)
    ? categoryKey.slice(FETCH_HOST_KEY_PREFIX.length) || undefined
    : undefined

// Pulls the target host out of a fetch request's STRUCTURED input.
//
// The display title is deliberately not consulted: the codebase treats titles as model-controlled
// display text (see resolveCategoryKey), and a grant key derived from it would let the model choose both
// the key it is granted and the key a later request is matched against — an escalation path. A request
// whose host cannot be read from provider metadata therefore stays one-shot.
export const fetchHostFromTrustedInput = (rawInput: unknown): string | undefined => {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined
  const record = rawInput as Record<string, unknown>
  for (const key of ['url', 'uri', 'href']) {
    const value = record[key]
    if (typeof value === 'string') {
      const host = fetchHostFromUrl(value)
      if (host) return host
    }
  }
  return undefined
}

/** The session-scope grant label the composer shows next to the revoke control. */
export const describeFetchHostGrant = (host: string): string => `Fetch domain: ${host}`
