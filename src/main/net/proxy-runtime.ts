// Proxy runtime: **two** routes, because the app has two kinds of traffic.
//
//  * `manualProxyEnvironment()` — the **child-process** route (notebook/REPL/shell): env vars, read by the
//    spawn paths.
//  * `applyProxySession()` — the **main-process** route. This one exists because of a real defect: the app
//    could be configured with a proxy and still fail its own downloads with a bare `fetch failed`. Every
//    main-process request that goes through Node's `fetch` (undici) ignores both the app's setting AND the
//    operating system's proxy configuration — so a weight download over a proxied network had no route at
//    all. `applyProxySession()` points Electron's session at the configured proxy, and the paths that fetch
//    big payloads (the weight cache) use Chromium's stack, which honours it.
//
// The settings layer pushes the persisted ProxySettings to both routes whenever they change.

import { hasManualProxy, proxyUrlFor, type ProxySettings } from '../../shared/proxy'
import { loopbackProxyBypassEnvironment } from '../settings/system-proxy'

let current: ProxySettings | undefined

// Updates the runtime from persisted settings. `undefined` clears the manual route
// back to the default (follow system).
export const applyProxySettings = (settings: ProxySettings | undefined): void => {
  current = settings
}

// Returns the child-process env for a configured manual proxy (undefined otherwise).
// Cheap: no I/O, no Electron session calls.
export const manualProxyEnvironment = (): NodeJS.ProcessEnv | undefined => {
  if (!hasManualProxy(current)) return undefined
  const manual = current?.manual
  if (!manual) return undefined

  const url = proxyUrlFor({ type: manual.type, host: manual.host.trim(), port: manual.port })
  // The OS bypass list is unioned in so an inherited corporate bypass survives, and
  // loopback is always added (see system-proxy's loopback bypass helper).
  const bypassBase = loopbackProxyBypassEnvironment()
  const userBypass = (manual.noProxy ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(',')
  const noProxy = userBypass ? `${userBypass},${bypassBase.NO_PROXY}` : bypassBase.NO_PROXY

  if (manual.type === 'socks5') {
    // Most HTTP clients only route SOCKS through ALL_PROXY; the http(s) vars stay
    // unset so a host-level HTTP proxy cannot shadow the SOCKS decision.
    return { ALL_PROXY: url, all_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy }
  }

  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy
  }
}

/**
 * Points Electron's session at the configured proxy (**main-process route**). `undefined` / no manual proxy
 * means "follow the system", which is Chromium's own default and the honest answer for "Follow system".
 *
 * Never throws: a proxy that cannot be applied must not break the settings write that triggered it. The
 * caller gets the reason back so it can be logged rather than swallowed.
 */
export const applyProxySession = async (
  settings: ProxySettings | undefined
): Promise<string | undefined> => {
  let session: { setProxy: (config: Record<string, unknown>) => Promise<void> } | undefined
  try {
    const electron = (await import('electron')) as unknown as {
      session?: {
        defaultSession?: { setProxy: (config: Record<string, unknown>) => Promise<void> }
      }
    }
    session = electron.session?.defaultSession
  } catch {
    return undefined
  }
  if (!session) return undefined

  const manual = settings?.manual
  try {
    if (!hasManualProxy(settings) || !manual) {
      await session.setProxy({ mode: 'system' })
      return undefined
    }
    const rules = proxyUrlFor({ type: manual.type, host: manual.host.trim(), port: manual.port })
    // Loopback is always bypassed (the app talks to its own services) and the user's own list is unioned in.
    const bypass = [
      ...(manual.noProxy ?? []).map((entry) => entry.trim()).filter(Boolean),
      'localhost',
      '127.0.0.1'
    ]
    await session.setProxy({ proxyRules: rules, proxyBypassRules: bypass.join(',') })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export const proxySettingsForTest = (): ProxySettings | undefined => current

export const resetProxyRuntimeForTest = (): void => {
  current = undefined
}
