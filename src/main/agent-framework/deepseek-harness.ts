import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../logger'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { openAiCompletionsBase } from '../settings/base-url'
import { augmentedPathEnv } from '../settings/shell-path'
import type { ResolvedProvider } from '../settings/provider-env'
import type {
  AgentFramework,
  AgentModelConfig,
  AgentSpawnInput,
  ModelConfigContext,
  SessionSetup,
  SessionSetupContext
} from './types'
import { renderAppMcpToolReferences } from './app-mcp-names'

// DeepSeek Harness ships its ACP server as a standalone npm package (`deepseek-harness-acp`, also answering
// to `dsh-acp`), so the interactive `dsh` CLI is not needed to drive it. Measured 2026-11-24 — see
// docs/evidence/2026-11-24-deepseek-harness-and-pi-acp-handshake.md: a spec-shaped `initialize` comes back in
// 2.2 s with `protocolVersion: 1`, `agentInfo {name: deepseek-harness-acp}`, image prompts on, session
// resume/list on, `authMethods: []` — and, unlike Hermes, it DOES advertise `mcpCapabilities {stdio, sse,
// http}`.
export const deepSeekHarnessStorageDir = (storageRoot: string): string =>
  join(storageRoot, 'deepseek-harness')

// The harness opens its session-search index with `node:sqlite` and runs `CREATE VIRTUAL TABLE … fts5`.
// Not every Node build ships SQLite with FTS5 — Homebrew's v23.11.0 on this machine does not, while v22.22.3
// does. The CLI is launched through its shebang, so whichever `node` the app's PATH resolves decides whether
// the plugin tree loads at all: under a build without FTS5 the whole harness dies with
// `session-search SQLite index failed to open: no such module: fts5` before ACP ever answers.
//
// So the interpreter is chosen by capability, not by PATH order: the first candidate that can actually
// create an fts5 table runs the CLI, and the shebang is bypassed for that case.
const FTS5_PROBE =
  "try{const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)');}catch(e){process.exit(3)}"

const nodeCandidates = (): string[] => {
  const fromPath = (process.env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .map((dir) => join(dir, 'node'))
  const known = [
    join(homedir(), '.local', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    join(homedir(), '.hermes', 'node', 'bin', 'node')
  ]

  return [...new Set([...fromPath, ...known])]
}

let cachedNode: string | null | undefined

const resolveFts5Node = (): string | undefined => {
  if (cachedNode !== undefined) return cachedNode ?? undefined

  for (const candidate of nodeCandidates()) {
    try {
      execFileSync(candidate, ['--no-warnings', '-e', FTS5_PROBE], {
        timeout: 5000,
        stdio: 'ignore'
      })
      cachedNode = candidate

      return candidate
    } catch {
      continue
    }
  }
  createLogger('agent-spawn').warn(
    'no node with SQLite FTS5 found; the harness may fail to load its plugins'
  )
  cachedNode = null

  return undefined
}

// An npm console script is a shell shim on Windows (`deepseek-harness-acp.cmd`), which Node cannot launch
// without a shell.
const isShellShim = (executablePath: string): boolean =>
  process.platform === 'win32' && /\.(cmd|bat)$/i.test(executablePath)

export const deepSeekHarnessFramework: AgentFramework = {
  id: 'deepseek-harness',
  displayName: 'DeepSeek Harness',

  // No compaction command appears in its `--help`; the runtime's own summarisation applies.
  contextCompaction: { kind: 'framework-managed' },

  // No config-dir skill surface was measured.
  supportsSkills: false,

  // The measured initialize result advertises stdio, sse and http MCP.
  acceptsStdioMcp: true,
  acceptsHttpMcp: true,

  supportsLiveEffortChange: false,

  // `DEEPSEEK_BASE_URL` is an OpenAI-compatible base URL.
  supportedApiTypes: ['openai'],

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    const needsShell = isShellShim(input.executablePath)
    const node = needsShell ? undefined : resolveFts5Node()
    const env = { ...augmentedPathEnv(process.env), ...input.env }

    if (node) {
      return spawn(node, [input.executablePath, ...(input.args ?? [])], {
        env,
        stdio: 'pipe',
        windowsHide: true
      })
    }

    return spawn(
      needsShell ? `"${input.executablePath}"` : input.executablePath,
      [...(input.args ?? [])],
      {
        env,
        stdio: 'pipe',
        windowsHide: true,
        shell: needsShell
      }
    )
  },

  prepareModelConfig(provider: ResolvedProvider, ctx: ModelConfigContext): AgentModelConfig {
    const baseUrl = openAiCompletionsBase(provider)
    if (!baseUrl || !provider.key || !provider.model) {
      throw new Error(
        'DeepSeek Harness requires an OpenAI-compatible base URL, API key, and model.'
      )
    }

    const dataRoot = deepSeekHarnessStorageDir(ctx.storageRoot)

    return {
      env: {
        // The three names `--version 0.1.27` documents: the key is required, the base URL overrides the
        // endpoint, and the sessions root keeps transcripts in this app's storage rather than in whatever
        // directory the process happened to start in (`./.sessions` by default).
        DEEPSEEK_API_KEY: provider.key,
        DEEPSEEK_BASE_URL: baseUrl,
        DSH_SESSIONS_ROOT: join(dataRoot, 'sessions'),
        // It starts with no config file at all (it calls itself Standalone), so the permission mode is the
        // one behaviour knob it takes from us. It stays at the restrictive value: this context carries no
        // permission profile, and the app's own broker is what enforces the user's choice — flipping the
        // server to danger-full-access on a guess would widen its file access without anyone asking.
        DSH_PERMISSION_MODE: 'workspace-write'
      },
      configFiles: [],
      sessionModel: provider.model
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    // No session `_meta` surface was measured, so app guidance rides the prompt prefix.
    const promptPrefix = [...ctx.systemPromptAppends, ...(ctx.turnPromptReminders ?? [])]
      .map((append) => renderAppMcpToolReferences('deepseek-harness', append))
      .filter(Boolean)
      .join('\n\n')

    return {
      ...(promptPrefix ? { promptPrefix } : {})
    }
  },

  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication {
    // The measured initialize result carries no mode surface, so the app's broker owns every decision and
    // the spawn env above carries the coarse mode.
    return resolvePermissionProfileApplication(profile, modes, {
      brokerEnforcesFullAccess: true
    })
  }
}
