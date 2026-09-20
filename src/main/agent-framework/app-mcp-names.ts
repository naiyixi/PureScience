import type { AgentFrameworkId } from './types'

type AppMcpServerDefinition = {
  canonicalName: string
  openCodeName: string
  tools: readonly string[]
  // Names this server used to be registered under. Frameworks namespace a server name into the tool name
  // they hand the model (mcp__<server>__<tool>) and each one escapes a hyphen its own way — some as one
  // underscore, some as two — so a hyphen in the name means the callable name depends on who is rendering
  // it. Hyphen-free canonical names are the fix; the old spellings stay here so a grant, a config or a
  // reported tool name written before the rename still resolves to the same identity.
  legacyNames?: readonly string[]
}

// App-owned MCP identity stays canonical inside PureScience. Framework-specific names are projected
// only at the agent-facing seam so permissions, grants, policy, and diagnostics keep one stable key.
const APP_MCP_SERVERS: readonly AppMcpServerDefinition[] = [
  {
    canonicalName: 'purescience-activity',
    openCodeName: 'purescience_activity',
    tools: ['begin_activity_group']
  },
  {
    canonicalName: 'purescience-artifacts',
    openCodeName: 'purescience_artifacts',
    tools: ['write_artifact_file']
  },
  {
    canonicalName: 'purescience_notebook',
    openCodeName: 'purescience_notebook',
    legacyNames: ['purescience-notebook'],
    tools: [
      'notebook_execute',
      'repl_execute',
      'bash_execute',
      'notebook_state',
      'list_notebook_runtimes',
      'notebook_bind_runtime',
      'notebook_switch_runtime',
      'notebook_restart',
      'notebook_shutdown',
      'inspect_packages',
      'manage_packages',
      'manage_environments'
    ]
  },
  {
    canonicalName: 'purescience-skills',
    openCodeName: 'purescience_skills',
    tools: ['request_skill_import']
  },
  {
    canonicalName: 'purescience-plan',
    openCodeName: 'purescience_plan',
    tools: ['generate_plan', 'update_step_status']
  },
  {
    canonicalName: 'purescience-memory',
    openCodeName: 'purescience_memory',
    tools: ['memory_save_note']
  }
]

const APP_MCP_SERVER_BY_CANONICAL_NAME = new Map(
  APP_MCP_SERVERS.map((definition) => [definition.canonicalName, definition])
)
const APP_MCP_SERVER_BY_OPENCODE_NAME = new Map(
  APP_MCP_SERVERS.map((definition) => [definition.openCodeName, definition])
)
const APP_MCP_SERVER_BY_LEGACY_NAME = new Map(
  APP_MCP_SERVERS.flatMap((definition) =>
    (definition.legacyNames ?? []).map((legacy) => [legacy, definition] as const)
  )
)

const frameworkSafeMcpServerName = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, '_')

const canonicalAppMcpServerName = (name: string): string =>
  APP_MCP_SERVER_BY_OPENCODE_NAME.get(name)?.canonicalName ??
  APP_MCP_SERVER_BY_LEGACY_NAME.get(name)?.canonicalName ??
  name

const modelFacingAppMcpServerName = (frameworkId: AgentFrameworkId, name: string): string => {
  const canonicalName = canonicalAppMcpServerName(name)
  const definition = APP_MCP_SERVER_BY_CANONICAL_NAME.get(canonicalName)

  return frameworkId === 'opencode' && definition ? definition.openCodeName : canonicalName
}

const appMcpServerAliases = (name: string): readonly string[] => {
  const canonicalName = canonicalAppMcpServerName(name)
  const definition = APP_MCP_SERVER_BY_CANONICAL_NAME.get(canonicalName)

  return [
    ...new Set(
      definition
        ? [definition.canonicalName, definition.openCodeName, ...(definition.legacyNames ?? [])]
        : [canonicalName, frameworkSafeMcpServerName(canonicalName)]
    )
  ]
}

// Canonical inventory used at cross-module policy seams. Callers receive identities only, keeping
// framework aliases and rendering details owned by this module.
const appMcpToolIdentities = (): readonly string[] =>
  APP_MCP_SERVERS.flatMap(({ canonicalName, tools }) =>
    tools.map((tool) => `${canonicalName}/${tool}`)
  )

const resolveCanonicalMcpToolIdentity = (
  name: string | null | undefined,
  mcpServerNames: readonly string[]
): string | undefined => {
  if (!name) return undefined

  const canonicalServers = [
    ...new Set(mcpServerNames.map((server) => canonicalAppMcpServerName(server)))
  ]
  const configuredServerFor = (reportedServer: string): string | undefined => {
    const matches = canonicalServers.filter((server) =>
      appMcpServerAliases(server).includes(reportedServer)
    )
    return matches.length === 1 ? matches[0] : undefined
  }

  if (name.startsWith('mcp__')) {
    const [reportedServer, ...toolParts] = name.slice('mcp__'.length).split('__')
    if (!reportedServer || toolParts.length === 0) return undefined
    const server = configuredServerFor(reportedServer)
    if (server) return `${server}/${toolParts.join('__')}`

    // A framework can escape the hyphen inside a server name as its own separator, which splits the
    // server across two segments (`mcp__purescience__notebook__notebook_execute`). Join the first two
    // segments with the hyphen the canonical name uses and look the whole thing up.
    if (toolParts.length >= 2) {
      const joined = configuredServerFor(`${reportedServer}-${toolParts[0]}`)
      if (joined) return `${joined}/${toolParts.slice(1).join('__')}`
    }

    return undefined
  }

  const serverAliases = canonicalServers
    .flatMap((server) => appMcpServerAliases(server).map((alias) => ({ alias, server })))
    .sort((left, right) => right.alias.length - left.alias.length)

  for (const { alias, server } of serverAliases) {
    const codexPrefix = `mcp.${alias}.`
    if (name.startsWith(codexPrefix)) return `${server}/${name.slice(codexPrefix.length)}`

    const openCodePrefix = `${alias}_`
    if (name.startsWith(openCodePrefix)) return `${server}/${name.slice(openCodePrefix.length)}`
  }

  return undefined
}

const modelFacingAppMcpToolName = (
  frameworkId: AgentFrameworkId,
  server: string,
  tool: string,
  codexBridgeAliases = false
): string => {
  const canonicalServer = canonicalAppMcpServerName(server)
  if (frameworkId === 'codex' && !codexBridgeAliases) {
    return `mcp.${canonicalServer}.${tool}`
  }
  if (frameworkId === 'opencode') {
    return `${modelFacingAppMcpServerName(frameworkId, canonicalServer)}_${tool}`
  }

  return `mcp__${canonicalServer.replace(/[^a-zA-Z0-9_]/g, '_')}__${tool}`
}

const renderAppMcpToolReferences = (frameworkId: AgentFrameworkId, text: string): string => {
  if (frameworkId === 'codex') return text

  let rendered = text
  for (const definition of APP_MCP_SERVERS) {
    const facingName = modelFacingAppMcpServerName(frameworkId, definition.canonicalName)
    // Prose that names the server by what it used to be called has to come out naming it the way this
    // framework sees it now, or the sentence hands the model a name it cannot call.
    for (const spelling of [
      definition.canonicalName,
      definition.openCodeName,
      ...(definition.legacyNames ?? [])
    ]) {
      if (spelling !== facingName) rendered = rendered.replaceAll(spelling, facingName)
    }
  }

  for (const definition of APP_MCP_SERVERS) {
    for (const tool of definition.tools) {
      const callableName =
        frameworkId === 'claude-code'
          ? `mcp__${definition.canonicalName}__${tool}`
          : modelFacingAppMcpToolName(frameworkId, definition.canonicalName, tool)
      rendered = rendered.replace(new RegExp(`\\b${tool}\\b`, 'g'), callableName)
    }
  }

  return rendered
}

export {
  appMcpToolIdentities,
  appMcpServerAliases,
  canonicalAppMcpServerName,
  modelFacingAppMcpServerName,
  modelFacingAppMcpToolName,
  resolveCanonicalMcpToolIdentity,
  renderAppMcpToolReferences
}
