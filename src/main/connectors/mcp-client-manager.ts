import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

import { OAuthCallbackServer, PersistentOAuthClientProvider } from './oauth-client'
import type { StoredCustomMcpOAuthState } from '../settings/types'

// Config for a user-added custom MCP server. OAuth state is a transient main-process projection;
// stdio remains non-OAuth and remote servers can use OAuth, static headers, or neither.
export type CustomMcpServerConfig = {
  id: string
  name: string
  transport: 'stdio' | 'streamable_http' | 'sse'
  // stdio (local command):
  command?: string
  args?: string[]
  env?: Record<string, string>
  // remote (streamable_http / sse):
  url?: string
  headers?: Record<string, string>
  oauth?: {
    clientMetadataUrl?: string
    authorizationServerUrl?: string
    scopes?: string[]
    state?: StoredCustomMcpOAuthState
  }
}

export type McpClientManagerTool = {
  name: string
  description?: string
  inputSchema?: unknown
}

type McpClientManagerDeps = {
  createClient?: (
    config: CustomMcpServerConfig,
    authProvider?: PersistentOAuthClientProvider
  ) => Promise<Client>
  openExternal?: (url: string) => Promise<void> | void
  saveOAuthState?: (serverId: string, state: StoredCustomMcpOAuthState) => Promise<void>
}

// Pure factory: picks the transport for a custom server config. Exported so callers/tests can
// build a transport without a full connect, and so defaultCreateClient below stays a thin wrapper.
export function buildTransport(
  config: CustomMcpServerConfig,
  authProvider?: PersistentOAuthClientProvider
): Transport {
  switch (config.transport) {
    case 'stdio': {
      if (!config.command) {
        throw new Error(`custom MCP server "${config.name}" is missing a command for stdio`)
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env
      })
    }
    case 'streamable_http': {
      if (!config.url) {
        throw new Error(`custom MCP server "${config.name}" is missing a url for streamable_http`)
      }
      return new StreamableHTTPClientTransport(new URL(config.url), {
        ...(authProvider ? { authProvider } : {}),
        ...(config.headers ? { requestInit: { headers: config.headers } } : {})
      })
    }
    case 'sse': {
      if (!config.url) {
        throw new Error(`custom MCP server "${config.name}" is missing a url for sse`)
      }
      return new SSEClientTransport(new URL(config.url), {
        ...(authProvider ? { authProvider } : {}),
        ...(config.headers ? { requestInit: { headers: config.headers } } : {})
      })
    }
  }
}

// Default factory: build the transport for the server's configured type and connect an MCP client.
async function defaultCreateClient(
  config: CustomMcpServerConfig,
  authProvider?: PersistentOAuthClientProvider
): Promise<Client> {
  const transport = buildTransport(config, authProvider)
  const client = new Client({ name: 'purescience', version: '0.0.0' })
  await client.connect(transport)
  return client
}

// Classifies a connection-level failure as transient (worth one reconnect-and-retry) vs. a
// genuine request error (auth, bad arguments, server-side application error — surfaced as-is).
// Connection failures are the SDK's transport/connection errors; everything else is the server
// answering, which retrying cannot fix.
const isTransientConnectionFailure = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /connection closed|connection lost|not connected|ECONNRESET|EPIPE|socket hang up|fetch failed|transport.*(closed|disconnect|error)|subprocess.*(exit|terminated)|server.*(exit|terminated)/i.test(
    message
  )
}

// MCP client for user-added custom servers (Phase 1: local/stdio). Mirrors the bundled
// ParserEngine's structured-dict + isError-throws call contract so ConnectorService can
// dispatch to either uniformly. Lazily connects and caches one client per server id.
export class McpClientManager {
  private readonly createClient: (
    config: CustomMcpServerConfig,
    authProvider?: PersistentOAuthClientProvider
  ) => Promise<Client>
  private readonly clients = new Map<string, Client>()
  private readonly connecting = new Map<string, Promise<Client>>()
  private readonly authenticationCancels = new Map<string, () => Promise<void>>()
  private readonly generations = new Map<string, number>()
  private readonly callbackServer = new OAuthCallbackServer()
  private readonly openExternal: (url: string) => Promise<void> | void
  private readonly saveOAuthState?: (
    serverId: string,
    state: StoredCustomMcpOAuthState
  ) => Promise<void>

  constructor(deps?: McpClientManagerDeps) {
    this.createClient = deps?.createClient ?? defaultCreateClient
    this.openExternal =
      deps?.openExternal ??
      (() => {
        throw new Error('No browser opener is configured for OAuth')
      })
    this.saveOAuthState = deps?.saveOAuthState
  }

  async listTools(config: CustomMcpServerConfig): Promise<McpClientManagerTool[]> {
    return this.withReconnectRetry(config, async (client) => {
      const { tools } = await client.listTools()
      return tools
    })
  }

  async call(
    config: CustomMcpServerConfig,
    method: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return this.withReconnectRetry(config, async (client) => {
      const result = await client.callTool({ name: method, arguments: args })
      return unwrapToolResult(result)
    })
  }

  async close(id: string): Promise<void> {
    this.generations.set(id, this.generation(id) + 1)
    const cancelAuthentication = this.authenticationCancels.get(id)
    this.authenticationCancels.delete(id)
    await cancelAuthentication?.()
    const client = this.clients.get(id)
    this.clients.delete(id)
    this.connecting.delete(id)
    if (client) await client.close()
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [
        ...new Set([
          ...this.clients.keys(),
          ...this.connecting.keys(),
          ...this.authenticationCancels.keys()
        ])
      ].map((id) => this.close(id))
    )
    await this.callbackServer.close()
  }

  async cancelAuthentication(id: string): Promise<void> {
    await this.close(id)
  }

  // Starts standard OAuth, waits for the loopback callback, and caches an authenticated client.
  async authenticate(config: CustomMcpServerConfig): Promise<void> {
    if (!config.oauth || config.transport === 'stdio') {
      throw new Error(`custom MCP server "${config.name}" is not configured for OAuth`)
    }
    let callback: ReturnType<OAuthCallbackServer['waitFor']> | undefined
    let activeClient: Client | undefined
    const cancelAuthentication = async (): Promise<void> => {
      callback?.cancel()
      const client = activeClient
      activeClient = undefined
      if (client) await client.close().catch(() => undefined)
    }
    const closing = this.close(config.id)
    const generation = this.generation(config.id)
    // Register before the first await so closeAll() can supersede startup during application exit.
    this.authenticationCancels.set(config.id, cancelAuthentication)
    try {
      await closing
      if (generation !== this.generation(config.id)) {
        throw new Error(`custom MCP server "${config.name}" connection was superseded`)
      }
      const redirectUrl = await this.callbackServer.ensureStarted()
      if (generation !== this.generation(config.id)) {
        throw new Error(`custom MCP server "${config.name}" connection was superseded`)
      }
      const provider = this.oauthProvider(config, redirectUrl, generation, true)
      callback = this.callbackServer.waitFor(provider.state())
      const transport = buildTransport(config, provider)
      const firstClient = new Client({ name: 'purescience', version: '0.0.0' })
      activeClient = firstClient
      try {
        await firstClient.connect(transport)
        if (generation !== this.generation(config.id)) {
          await firstClient.close().catch(() => undefined)
          throw new Error(`custom MCP server "${config.name}" connection was superseded`)
        }
        this.clients.set(config.id, firstClient)
        activeClient = undefined
        return
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error
        await firstClient.close().catch(() => undefined)
        if (activeClient === firstClient) activeClient = undefined
      }

      try {
        const result = await callback.promise
        if (result.error) throw new Error(`OAuth authorization failed: ${result.error}`)
        if (!result.code) throw new Error('OAuth callback did not include an authorization code')

        await (transport as StreamableHTTPClientTransport | SSEClientTransport).finishAuth(
          result.code
        )
      } finally {
        await provider.invalidateCredentials('verifier')
      }
      // Recreate the transport/client after the SDK has completed the authorization-code exchange.
      const client = new Client({ name: 'purescience', version: '0.0.0' })
      activeClient = client
      await client.connect(buildTransport(config, provider))
      if (generation !== this.generation(config.id)) {
        await client.close().catch(() => undefined)
        throw new Error(`custom MCP server "${config.name}" connection was superseded`)
      }
      this.clients.set(config.id, client)
      activeClient = undefined
    } finally {
      await cancelAuthentication()
      if (this.authenticationCancels.get(config.id) === cancelAuthentication) {
        this.authenticationCancels.delete(config.id)
      }
    }
  }

  // Lazily connects, caching the client by server id and deduping concurrent connect calls.
  private async connect(config: CustomMcpServerConfig): Promise<Client> {
    const cached = this.clients.get(config.id)
    if (cached) return cached

    const inFlight = this.connecting.get(config.id)
    if (inFlight) return inFlight

    const generation = this.generation(config.id)
    const connectPromise = this.createClientWithOAuth(config, generation)
      .then(async (client) => {
        if (generation !== this.generation(config.id)) {
          await client.close().catch(() => undefined)
          throw new Error(`custom MCP server "${config.name}" connection was superseded`)
        }
        this.clients.set(config.id, client)
        return client
      })
      .finally(() => {
        if (this.connecting.get(config.id) === connectPromise) {
          this.connecting.delete(config.id)
        }
      })
    this.connecting.set(config.id, connectPromise)
    return connectPromise
  }

  // A custom MCP server can drop mid-session: a stdio subprocess exits (crash, restart, upgrade) or
  // an HTTP transport loses its socket. Rather than surfacing a dead connection as a hard error, a
  // transient connection failure discards the stale cached client, reconnects once, and retries the
  // operation — the server is expected to be reachable again after a brief interruption.
  private async withReconnectRetry<T>(
    config: CustomMcpServerConfig,
    run: (client: Client) => Promise<T>
  ): Promise<T> {
    const client = await this.connect(config)
    try {
      return await run(client)
    } catch (error) {
      if (!isTransientConnectionFailure(error)) throw error
      const cached = this.clients.get(config.id)
      if (cached) {
        this.clients.delete(config.id)
        this.generations.set(config.id, this.generation(config.id) + 1)
        await cached.close().catch(() => undefined)
      }
      const fresh = await this.connect(config)
      return run(fresh)
    }
  }

  private async createClientWithOAuth(
    config: CustomMcpServerConfig,
    generation: number
  ): Promise<Client> {
    if (!config.oauth) return this.createClient(config)
    const redirectUrl = await this.callbackServer.ensureStarted()
    return this.createClient(config, this.oauthProvider(config, redirectUrl, generation))
  }

  private oauthProvider(
    config: CustomMcpServerConfig,
    redirectUrl: string,
    generation: number,
    interactive = false
  ): PersistentOAuthClientProvider {
    return new PersistentOAuthClientProvider({
      serverId: config.id,
      redirectUrl,
      config: config.oauth ?? {},
      state: config.oauth?.state,
      ...(interactive ? { openExternal: this.openExternal } : {}),
      saveState: this.saveOAuthState
        ? (state) =>
            generation === this.generation(config.id)
              ? this.saveOAuthState!(config.id, state)
              : Promise.resolve()
        : undefined
    })
  }

  private generation(id: string): number {
    return this.generations.get(id) ?? 0
  }
}

// Unwraps a callTool() result the same way the bundled engine's descriptors return data:
// isError -> throw; a single text content block -> JSON.parse (fallback to { text }); else raw.
function unwrapToolResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result
  const { content, isError } = result as { content?: unknown; isError?: boolean }
  const first = Array.isArray(content) ? content[0] : undefined
  const text =
    typeof first === 'object' && first !== null && (first as { type?: unknown }).type === 'text'
      ? (first as { text?: unknown }).text
      : undefined

  if (isError) {
    throw new Error(typeof text === 'string' ? text : 'MCP tool call failed')
  }
  if (typeof text === 'string') {
    try {
      return JSON.parse(text)
    } catch {
      return { text }
    }
  }
  return result
}
