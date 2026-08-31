// xAI Grok OAuth subscription provider (SuperGrok / X Premium+).
//
// Standard RFC 8628 device-authorization flow against xAI's OIDC issuer (auth.x.ai), following the
// public client registration used by the Hermes Agent integration. The resulting bearer token talks
// to the xAI API (api.x.ai/v1) — Responses and Chat Completions both accept it, so OpenCode and
// Codex routes work without an API key. Tokens are stored encrypted via the shared crypto helpers.
//
// NOTE: xAI's backend enforces its own tier allowlist on OAuth API access; some SuperGrok tiers get
// HTTP 403 after a successful login. The API-key path (official xai vendor) remains the reliable
// fallback.

import { shell } from 'electron'
import { createLogger } from '../logger'

const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const XAI_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`

const log = createLogger('xai-oauth')

export type XaiOauthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

export type XaiDeviceCodeSession = {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresIn: number
  interval: number
}

type OidcDiscovery = {
  token_endpoint: string
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`xAI OAuth HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  return (await response.json()) as T
}

// Loads the token endpoint from OIDC discovery (cached in-memory for the process lifetime).
let discoveryCache: OidcDiscovery | undefined
const resolveTokenEndpoint = async (): Promise<string> => {
  if (discoveryCache?.token_endpoint) return discoveryCache.token_endpoint
  const discovery = await fetchJson<OidcDiscovery>(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: 'application/json' }
  })
  if (!discovery.token_endpoint) {
    throw new Error('xAI OIDC discovery returned no token_endpoint')
  }
  discoveryCache = discovery
  return discovery.token_endpoint
}

// Starts the device-authorization flow. Returns a session the caller shows to the user
// (verification URL + code) and passes to pollForTokens().
export const startXaiDeviceFlow = async (): Promise<XaiDeviceCodeSession> => {
  const payload = await fetchJson<{
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
  }>(XAI_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }).toString()
  })
  if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
    throw new Error('xAI device-code request returned an incomplete payload')
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUrl: payload.verification_uri_complete ?? payload.verification_uri,
    expiresIn: payload.expires_in ?? 600,
    interval: payload.interval ?? 5
  }
}

// Opens the verification URL in the system browser (best-effort; headless environments just show it).
export const openXaiVerificationUrl = async (url: string): Promise<boolean> => {
  try {
    await shell.openExternal(url)
    return true
  } catch (error) {
    log.warn('could not open xAI verification URL', { error })
    return false
  }
}

// Polls the token endpoint until the user authorizes or the session expires.
export const pollXaiTokens = async (
  session: XaiDeviceCodeSession,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<XaiOauthTokens> => {
  const tokenEndpoint = await resolveTokenEndpoint()
  const deadline = Date.now() + session.expiresIn * 1000
  const timeoutMs = options.timeoutMs ?? Math.min(session.expiresIn * 1000, 300_000)

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('xAI OAuth polling aborted')
    const payload = await fetchJson<TokenResponse>(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: session.deviceCode,
        client_id: XAI_OAUTH_CLIENT_ID
      }).toString()
    })
    if (payload.access_token) {
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000
      }
    }
    if (payload.error === 'authorization_pending') {
      // Not authorized yet — wait the server-suggested interval and poll again.
      await new Promise((resolve) => setTimeout(resolve, session.interval * 1000))
      continue
    }
    if (payload.error === 'slow_down') {
      await new Promise((resolve) => setTimeout(resolve, (session.interval + 5) * 1000))
      continue
    }
    if (payload.error === 'expired_token' || payload.error === 'access_denied') {
      throw new Error(
        `xAI OAuth ${payload.error}: ${payload.error_description ?? 'authorization failed'}`
      )
    }
    // Unknown error — surface it.
    throw new Error(`xAI OAuth error: ${payload.error} ${payload.error_description ?? ''}`.trim())
  }
  void timeoutMs
  throw new Error('xAI OAuth authorization timed out')
}

// Refreshes an expiring token set using its refresh token.
export const refreshXaiTokens = async (refreshToken: string): Promise<XaiOauthTokens> => {
  const tokenEndpoint = await resolveTokenEndpoint()
  const payload = await fetchJson<TokenResponse>(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: XAI_OAUTH_CLIENT_ID
    }).toString()
  })
  if (!payload.access_token) {
    throw new Error(`xAI OAuth refresh failed: ${payload.error ?? 'no access_token'}`)
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000
  }
}

// Returns true when a token is still valid (with a small skew window).
export const isXaiTokenValid = (tokens: XaiOauthTokens, skewMs = 60_000): boolean =>
  tokens.expiresAt > Date.now() + skewMs
