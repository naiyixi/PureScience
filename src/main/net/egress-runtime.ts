// Egress restriction runtime: owns the single filtering proxy and derives the child-process env
// that routes kernel / repl / shell traffic through it. The allowlist is pushed in by the settings
// layer whenever egress settings change; kernel/shell spawn paths read `egressProxyEnv()` and merge
// the result into their env when defined (restrictions on) — otherwise they keep current behavior.

import { resolveEgressAllowlist, type EgressSettings } from '../../shared/egress'
import { EgressProxy } from './egress-proxy'

let proxy: EgressProxy | undefined
let currentAllowlist: string[] | undefined
let currentEnabled = false

// Updates the runtime from persisted settings and returns the proxy env for child processes
// (undefined when egress is off).
export const applyEgressSettings = async (
  settings: EgressSettings | undefined
): Promise<NodeJS.ProcessEnv | undefined> => {
  const allowlist = resolveEgressAllowlist(settings)
  currentEnabled = allowlist !== undefined
  currentAllowlist = allowlist

  if (!currentEnabled) {
    if (proxy) {
      proxy.setAllowlist(undefined)
      await proxy.stop()
      proxy = undefined
    }
    return undefined
  }

  proxy ??= new EgressProxy()
  proxy.setAllowlist(allowlist)
  const port = await proxy.start()
  return {
    HTTP_PROXY: `http://127.0.0.1:${port}`,
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
    // Route everything through the proxy; the proxy itself decides.
    NO_PROXY: '',
    no_proxy: ''
  }
}

// Returns the current child-process proxy env (undefined = unrestricted). Cheap: no I/O.
export const egressProxyEnv = (): NodeJS.ProcessEnv | undefined => {
  if (!currentEnabled || !proxy) return undefined
  return {
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    NO_PROXY: '',
    no_proxy: ''
  }
}

// Whether egress restrictions are currently active (for diagnostics/tests).
export const isEgressActive = (): boolean => currentEnabled
export const egressAllowlistForTest = (): string[] | undefined => currentAllowlist
