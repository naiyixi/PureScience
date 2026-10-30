// Where `purescience mcp` learns how to reach the running app.
//
// An outside client starts the CLI process itself, so it cannot receive the environment the app injects
// into its own MCP children (that is the gap this whole feature closes). The app therefore publishes one
// small file in the config root — the endpoint it is listening on and a per-process bearer token — and the
// CLI reads it. Same shape and permissions as `web-service.json` / `web-token`: the own-user config
// directory, mode 0600, written atomically.
//
// The token is a secret: it is never logged, never printed by the CLI, and the file is removed when the
// server stops. A crash can leave it behind, so the reader (`purescience mcp`, in the CLI package) cross-
// checks the pid and treats a dead owner as "not running" (and deletes the stale file) rather than handing
// back a token nobody honours. The filename is declared twice on purpose — the app writes it and the CLI
// package reads it, and the CLI ships without a dependency on this tree.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const EXTERNAL_MCP_STATE_FILE = 'external-mcp.json'

export type ExternalMcpState = {
  pid: number
  // Full MCP endpoint, e.g. http://127.0.0.1:51234/mcp
  endpoint: string
  token: string
  startedAt: string
  configRoot: string
}

const externalMcpStatePathFor = (configRoot: string): string =>
  join(configRoot, EXTERNAL_MCP_STATE_FILE)

const writeExternalMcpState = async (
  configRoot: string,
  state: Omit<ExternalMcpState, 'configRoot'>
): Promise<ExternalMcpState> => {
  const completeState = { ...state, configRoot }
  const statePath = externalMcpStatePathFor(configRoot)
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(completeState, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await rename(temporaryPath, statePath)
  return completeState
}

const removeExternalMcpState = async (configRoot: string): Promise<void> => {
  await rm(externalMcpStatePathFor(configRoot), { force: true })
}

export { EXTERNAL_MCP_STATE_FILE, removeExternalMcpState, writeExternalMcpState }
