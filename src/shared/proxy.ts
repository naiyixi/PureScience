// Outbound proxy for child processes (notebook kernels / REPL / shell).
//
// `system` (default) follows the operating system's proxy settings via Electron's
// session proxy resolution (see src/main/settings/system-proxy.ts); `manual` pins a
// fixed proxy on every spawned child process. The manual route never applies while
// the egress allowlist is active — the local filtering proxy owns the child-process
// route then (see src/main/net/egress-runtime.ts and the spawn-site merge order).

export const PROXY_TYPES = ['http', 'https', 'socks5'] as const

export type ProxyType = (typeof PROXY_TYPES)[number]

export type ProxyMode = 'system' | 'manual'

export type ManualProxyConfig = {
  type: ProxyType
  // Hostname or IP, without scheme or port (e.g. "127.0.0.1", "proxy.example.com").
  host: string
  port: number
  // Hosts / IPs / CIDRs that connect directly, bypassing the proxy. Loopback is
  // always bypassed regardless of this list.
  noProxy?: string[]
}

export type ProxySettings = {
  mode: ProxyMode
  manual?: ManualProxyConfig
}

export const DEFAULT_PROXY_SETTINGS: ProxySettings = { mode: 'system' }

export const PROXY_PORT_RANGE = { min: 1, max: 65535 } as const

export const proxyUrlFor = (config: ManualProxyConfig): string =>
  `${config.type}://${config.host}:${config.port}`

// True when a manual proxy is both selected and fully configured.
export const hasManualProxy = (settings: ProxySettings | undefined): boolean =>
  settings?.mode === 'manual' &&
  settings.manual !== undefined &&
  settings.manual.host.trim() !== '' &&
  Number.isInteger(settings.manual.port) &&
  settings.manual.port >= PROXY_PORT_RANGE.min &&
  settings.manual.port <= PROXY_PORT_RANGE.max
