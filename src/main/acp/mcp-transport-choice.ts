// Which MCP transport a session's capability servers are handed to the agent over.
//
// This is a cold-start decision, not a preference: with `stdio` the agent spawns one child per
// capability (14 per session), and each child pays ~123 ms of Electron-as-node boot plus ~180 ms of
// MCP SDK/module loading — measured on a packaged build, both irreducible. Fourteen of those at once
// became a 2.6 s burst on a loaded machine, and production hit the agent's 10 s readiness budget with
// 11 of 14 still pending. Over `http` the app serves the same tools from the already-running MCP host
// and the agent connects instead of spawning: no children, no budget spent on boots.
//
// `acceptsHttpMcp` is optional on purpose. Left undefined it keeps the historical rule exactly — http
// is usable only for a framework that cannot take stdio — so a framework is flipped only after ITS
// transport is verified, never by a default change nobody measured.

export type McpTransport = 'stdio' | 'http' | 'none'

export interface McpTransportInput {
  readonly acceptsStdioMcp: boolean
  /** Explicit "this framework can talk http MCP". Undefined = only when stdio is impossible. */
  readonly acceptsHttpMcp?: boolean
  /** False when the app has no MCP http host to serve from (then http is not an option at all). */
  readonly httpHostAvailable: boolean
}

export const resolveMcpTransport = (input: McpTransportInput): McpTransport => {
  const httpAcceptable = input.acceptsHttpMcp ?? !input.acceptsStdioMcp
  if (httpAcceptable && input.httpHostAvailable) return 'http'
  if (input.acceptsStdioMcp) return 'stdio'
  return 'none'
}
