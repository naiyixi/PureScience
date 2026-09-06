import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { openAiChatCompletionsUrl, openAiCompletionsBase } from '../settings/base-url'
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

// CodeBuddy (Tencent AI Coding) speaks ACP over `codebuddy --acp` (stdio JSON-RPC). It is an
// OpenAI-compatible-only framework: the app provider must resolve to an OpenAI /v1/chat/completions
// endpoint, and the model is injected through app-owned env + generated config files (models.json,
// settings.json) under an isolated CODEBUDDY_CONFIG_DIR so the user's own CodeBuddy config is never
// read or written. See docs/internal/pluggable-agent-framework-feasibility.md.

// The app owns CodeBuddy's whole config tree under <storageRoot>/codebuddy (mirror of CLAUDE_CONFIG_DIR
// isolation). Pointing CODEBUDDY_CONFIG_DIR there means the app provider/model is the only credential
// the process ever sees; the user's global CodeBuddy config/auth are untouched.
export const codeBuddyStorageDir = (storageRoot: string): string => join(storageRoot, 'codebuddy')

// The decrypted provider key rides this spawn-env var; the generated models.json references it via the
// `${PURESCIENCE_...}` template so the plaintext never lands on disk.
const CODEBUDDY_API_KEY_ENV = 'PURESCIENCE_CODEBUDDY_API_KEY'

// Tool surface: local file primitives only. Shell execution stays on the app-owned Notebook tool so
// Python/R requests follow its kernel-routing contract instead of CodeBuddy's prefix-bypassable native
// Bash rules. Network tools are denied outright (routing is app-owned).
const CODEBUDDY_LOCAL_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep']

const CODEBUDDY_NETWORK_DENY_RULES = [
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(aria2c:*)',
  'Bash(http:*)',
  'Bash(https:*)',
  'Bash(ftp:*)',
  'Bash(lftp:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'Bash(sftp:*)',
  'Bash(telnet:*)',
  'Bash(nc:*)',
  'Bash(ncat:*)',
  'Bash(netcat:*)',
  'Bash(socat:*)',
  'Bash(rsync:*)',
  'Bash(git clone:*)',
  'Bash(git fetch:*)',
  'Bash(git pull:*)',
  'Bash(git push:*)',
  'Bash(git ls-remote:*)',
  'Bash(git submodule:*)'
]

// CodeBuddy's settings.json cleanup window (days); auto-compact stays off because the app owns
// compaction via the native /compact command.
const CODEBUDDY_CLEANUP_PERIOD_DAYS = 7

// One switchable agent backend: CodeBuddy. The ACP runtime stays generic; this object owns only the
// framework-coupled decisions (spawn shape, model config translation, session setup, permissions).
export const codeBuddyFramework: AgentFramework = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',

  // Keeps slash-command details at the framework seam so the generic runtime only asks for native
  // compaction and never branches on framework ids.
  contextCompaction: {
    kind: 'native-command',
    command: '/compact',
    triggerAtPercent: 90
  },

  // CodeBuddy does not surface a config-dir materialized skill surface the app can provision.
  supportsSkills: false,

  // CodeBuddy accepts stdio MCP servers via ACP session mcpServers.
  acceptsStdioMcp: true,

  // CodeBuddy's ACP adapter advertises a live effort configOption.
  supportsLiveEffortChange: true,

  // CodeBuddy is an OpenAI-compatible-only client.
  supportedApiTypes: ['openai'],

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    // `codebuddy --acp` starts the ACP subprocess over stdio. On Windows an npm-installed CodeBuddy is
    // a `.cmd`/`.bat` shim that Node cannot launch without a shell, so those go through the shell with
    // the path quoted; a native `.exe`/Unix binary spawns directly.
    const needsShell = process.platform === 'win32' && /\\.(cmd|bat)$/i.test(input.executablePath)

    return spawn(
      needsShell ? `"${input.executablePath}"` : input.executablePath,
      ['--acp', ...input.args],
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
    const chatCompletionsUrl = openAiChatCompletionsUrl(provider)
    if (!baseUrl || !chatCompletionsUrl || !provider.key || !provider.model) {
      throw new Error('CodeBuddy requires an OpenAI-compatible base URL, API key, and model.')
    }

    const configDir = codeBuddyStorageDir(ctx.storageRoot)
    const persistentSystemPrompt = ctx.systemPromptAppends?.filter(Boolean).join('\n\n')
    const systemPromptPath = join(configDir, 'system-prompt.md')
    const maxInputTokens = provider.maxInputTokens ?? provider.contextWindow
    const modelConfig = {
      id: provider.model,
      name: provider.model,
      vendor: provider.vendorId ?? 'OpenAI-compatible',
      apiKey: `\${${CODEBUDDY_API_KEY_ENV}}`,
      ...(maxInputTokens ? { maxInputTokens } : {}),
      ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}),
      url: '${PURESCIENCE_CODEBUDDY_CHAT_COMPLETIONS_URL}',
      supportsToolCall: true,
      supportsImages: provider.supportsImageInput === true,
      supportsReasoning: Boolean(ctx.reasoningEfforts?.length)
    }

    return {
      env: {
        CODEBUDDY_CONFIG_DIR: configDir,
        CODEBUDDY_API_KEY: provider.key,
        CODEBUDDY_BASE_URL: baseUrl,
        CODEBUDDY_MODEL: provider.model,
        PURESCIENCE_CODEBUDDY_CHAT_COMPLETIONS_URL: chatCompletionsUrl,
        CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: '1',
        CODEBUDDY_DISABLE_HOT_RELOAD: '1',
        CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
        CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: '1',
        CODEBUDDY_DISABLE_FORK_SUBAGENT: '1',
        CODEBUDDY_DISABLE_BACKGROUND_TASKS: '1',
        CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CODEBUDDY_DEFER_TOOL_LOADING: '0',
        CODEBUDDY_SKIP_GIT_BASH_CHECK: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        NO_BROWSER: '1'
      },
      configFiles: [
        {
          path: join(configDir, 'models.json'),
          mode: 0o600,
          content: `${JSON.stringify(
            { models: [modelConfig], availableModels: [provider.model] },
            null,
            2
          )}\n`
        },
        {
          path: join(configDir, 'settings.json'),
          mode: 0o600,
          content: `${JSON.stringify(
            {
              cleanupPeriodDays: CODEBUDDY_CLEANUP_PERIOD_DAYS,
              autoCompactEnabled: false,
              permissions: { deny: ['WebFetch', 'WebSearch'] },
              sandbox: {
                enabled: process.platform !== 'win32',
                autoAllowBashIfSandboxed: false,
                excludedCommands: [],
                allowUnsandboxedCommands: false,
                network: { allowUnixSockets: [], allowLocalBinding: false }
              }
            },
            null,
            2
          )}\n`
        },
        ...(persistentSystemPrompt
          ? [{ path: systemPromptPath, mode: 0o600, content: persistentSystemPrompt }]
          : [])
      ],
      args: [
        // Shell execution stays on the app-owned Notebook tool so Python/R requests follow its
        // kernel-routing contract instead of CodeBuddy's prefix-bypassable native Bash rules.
        '--strict-mcp-config',
        '--setting-sources',
        'user',
        '--tools',
        CODEBUDDY_LOCAL_TOOLS.join(','),
        '--disallowedTools',
        ...CODEBUDDY_NETWORK_DENY_RULES,
        ...(persistentSystemPrompt ? ['--system-prompt-file', systemPromptPath] : [])
      ],
      sessionModel: provider.model,
      ...(persistentSystemPrompt ? { persistentSystemPrompt } : {})
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    const promptPrefix = [...ctx.systemPromptAppends, ...(ctx.turnPromptReminders ?? [])]
      .map((append) => renderAppMcpToolReferences('codebuddy', append))
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
    // CodeBuddy advertises a `fullAccess` mode rather than Claude's `bypassPermissions`; the app still
    // owns permission decisions (native config denies network tools and keeps local tools client-gated),
    // so the broker enforces ask/auto/full app-side.
    return resolvePermissionProfileApplication(profile, modes, {
      brokerEnforcesFullAccess: true
    })
  }
}
