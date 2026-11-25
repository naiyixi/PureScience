import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
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

    return spawn(
      needsShell ? `"${input.executablePath}"` : input.executablePath,
      [...(input.args ?? [])],
      {
        env: { ...augmentedPathEnv(process.env), ...input.env },
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
