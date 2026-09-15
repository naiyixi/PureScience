// Whether a provider endpoint carries credentials and conversations in the clear.
//
// The posture is deny by default: an `http://` endpoint outside loopback sends the API key and every
// message unencrypted, so it is refused until that provider explicitly opts in — and the opt-in is
// per provider, because "one host is fine" must never become "insecure endpoints are fine". Loopback is
// exempt: that traffic never leaves the machine.
//
// Deliberately NOT a hard refusal of http everywhere: users run local gateways and VPN-side proxies, and
// breaking those outright would push people to disable the check in a way this code cannot see. The
// refusal names the endpoint and the reason, and the escape hatch is recorded per provider.
export type EndpointTransport = 'https' | 'loopback' | 'insecure'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

// Absent/blank → undefined: there is no endpoint to judge. Unparseable → also undefined: "this is not a
// URL" belongs to the URL parser, which reports it as an invalid base URL — calling it insecure here
// would hide the real reason behind a transport verdict.
export const classifyEndpointTransport = (
  url: string | undefined
): EndpointTransport | undefined => {
  const trimmed = url?.trim()
  if (!trimmed) return undefined

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }

  if (parsed.protocol === 'https:') return 'https'
  if (parsed.protocol !== 'http:') return 'insecure'
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ? 'loopback' : 'insecure'
}

/** Stable code the caller can act on; the renderer turns it into the reader's language. */
export const ENDPOINT_INSECURE_REASON = 'insecure-endpoint'

export type EndpointTransportDecision =
  | { allowed: true; transport: EndpointTransport | undefined }
  | {
      allowed: false
      transport: 'insecure'
      reason: typeof ENDPOINT_INSECURE_REASON
      /** Canonical English sentence; the UI localizes from `reason` where it has copy for it. */
      message: string
    }

export const reviewEndpointTransport = (input: {
  url: string | undefined
  allowInsecureEndpoint?: boolean
}): EndpointTransportDecision => {
  const transport = classifyEndpointTransport(input.url)
  if (transport !== 'insecure' || input.allowInsecureEndpoint === true) {
    return { allowed: true, transport }
  }
  return {
    allowed: false,
    transport: 'insecure',
    reason: ENDPOINT_INSECURE_REASON,
    message: `Refusing to send credentials to a plaintext endpoint (${input.url?.trim() ?? ''}). Use https, or allow a plaintext endpoint for this provider explicitly.`
  }
}

/** Throwing form for the paths that must not continue: agent spawn and provider probes. */
export const assertEndpointTransportAllowed = (input: {
  url: string | undefined
  allowInsecureEndpoint?: boolean
}): void => {
  const decision = reviewEndpointTransport(input)
  if (!decision.allowed) throw new Error(decision.message)
}
