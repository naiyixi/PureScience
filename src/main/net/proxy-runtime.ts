// Manual-proxy runtime for child processes. The settings layer pushes the persisted
// ProxySettings here whenever they change; notebook/REPL/shell spawn paths read
// `manualProxyEnvironment()` and merge it when egress restrictions are inactive
// (egress owns the child-process route while the allowlist is on).

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

export const proxySettingsForTest = (): ProxySettings | undefined => current

export const resetProxyRuntimeForTest = (): void => {
  current = undefined
}
