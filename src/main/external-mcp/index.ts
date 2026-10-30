// Entry point for the app-side external MCP surface.
//
// One factory so the composition root wires this with a single call and gets a single `stop`: it owns the
// application-command client (and therefore the caller leases), binds every tool call to the narrow
// external-MCP command view under an `external-mcp` caller context, and starts the loopback listener.
//
// Starting is failure-tolerant by design: an outside client is a convenience surface, and a port that cannot
// be bound must never take the app down with it. A failure is logged with its message and reported to the
// caller as `undefined`, which the composition root treats as "not offered" — `purescience mcp` then says
// the app is not reachable instead of hanging.

import type { ApplicationCommandByNameDispatcher } from '../application-command-composition'
import { createApplicationCommandClient } from '../application-command-client'
import { createExternalMcpCallerContext } from '../caller-context'
import { createLogger } from '../logger'
import { ExternalMcpServer, type ExternalMcpInvoke } from './server'

const log = createLogger('external-mcp')

export type ExternalMcpHandle = Readonly<{
  endpoint: string
  stop: () => Promise<void>
}>

const startExternalMcpServer = async ({
  commands,
  configRoot
}: {
  /** The composition's external-MCP view — not the Web or desktop dispatcher. */
  commands: ApplicationCommandByNameDispatcher
  configRoot: string
}): Promise<ExternalMcpHandle | undefined> => {
  const client = createApplicationCommandClient()
  const invoke: ExternalMcpInvoke = ({ clientId, commandName, args }) =>
    client.invoke(commands, commandName, createExternalMcpCallerContext(clientId), args)

  const server = new ExternalMcpServer({ invoke, configRoot })
  try {
    const { endpoint } = await server.start()
    return Object.freeze({
      endpoint,
      stop: async (): Promise<void> => {
        try {
          await server.stop()
        } finally {
          client.dispose()
        }
      }
    })
  } catch (error) {
    client.dispose()
    await server.stop().catch(() => undefined)
    log.warn('external MCP server not started', {
      message: error instanceof Error ? error.message : String(error)
    })
    return undefined
  }
}

export { startExternalMcpServer, ExternalMcpServer }
