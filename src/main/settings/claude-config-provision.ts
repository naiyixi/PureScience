import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeCodeSkillMaterializer, type SkillMaterializer } from '../skills/materializer'
import { SkillRegistry, type BundledSkill } from '../skills/registry'
import {
  isPathGuardHookEntry,
  pathGuardHookSettings,
  writePathGuard
} from './path-guard-hook'
import {
  isSkillUsageHookEntry,
  skillUsageHookSettings,
  writeSkillUsageCapture
} from './skill-usage-hook'

// The app owns `<storageRoot>/claude` and provisions its settings and skills there. Isolated/API-key
// providers use it as CLAUDE_CONFIG_DIR; shared auth keeps CLAUDE_CONFIG_DIR=~/.claude and loads this
// directory as a session-local plugin/settings layer, so the user's profile is never modified.

// Subdirs Claude loads app-scoped assets from.
const APP_ASSET_SUBDIRS = ['skills', 'plugins', 'commands'] as const
const APP_PLUGIN_MANIFEST_DIR = '.claude-plugin'

// The agent's own file tools must not read (or search) the app config dir — it holds materialized
// skill files, whose (bundled / MCP) contents must never be surfaced verbatim into the conversation.
// Skill *loading* is internal to the agent and unaffected by these tool-level deny rules. The kernel
// (bash/subprocess) is guarded separately; see the notebook audit hook and read-guard spec.
const GUARDED_FILE_TOOLS = ['Read', 'Edit', 'Glob', 'Grep'] as const

// Built-in agent tools disabled outright in this app. Empty by default: the model's open-web tools
// (WebSearch/WebFetch) are left enabled so the agent can reach the open web alongside the curated MCP
// research connectors. Add a tool name here to fence it out of the app-owned user scope.
//
// Tradeoff: #105 originally denied WebSearch as an exfiltration-channel hardening measure (open-web
// reach is a path for conversation/workspace data to leave the app). Re-opening it accepts that risk
// in exchange for the model's built-in web reach. Subscription WebFetch additionally relies on the
// CLI's claude.ai domain-safety preflight. Custom API-key sessions cannot reach that hard-coded check,
// so they force every WebFetch call through the app broker for explicit Once-only approval.
const DENIED_BUILTIN_TOOLS = [] as const

// Built-in tool deny entries this module OWNS across versions — the full set it has ever written into
// `permissions.deny`, regardless of what DENIED_BUILTIN_TOOLS currently holds. Provisioning prunes
// these from the existing file before re-adding the current DENIED_BUILTIN_TOOLS, so the deny list
// stays declarative (reflects present policy) instead of accumulating stale entries. Without this, a
// tool removed from DENIED_BUILTIN_TOOLS would stay denied forever on installs that once persisted it
// (e.g. WebSearch written by #105). Unrelated user/third-party deny rules are never touched.
const MANAGED_BUILTIN_TOOLS = ['WebSearch'] as const

// Builds the claude-code permission deny rules that fence the agent's file tools out of `configDir`.
// Claude Code permission paths are gitignore-style with forward slashes, where a `//<abs>` prefix
// denotes an absolute filesystem path. Normalize Windows backslashes and collapse the leading slash
// so both POSIX (`/Users/…` -> `//Users/…`) and Windows (`C:\…` -> `//C:/…`) yield the `//` form.
const configDenyRules = (configDir: string): string[] => {
  const abs = configDir.replace(/\\/g, '/').replace(/^\/+/, '')
  return GUARDED_FILE_TOOLS.map((tool) => `${tool}(//${abs}/**)`)
}

// Writes/merges `<configDir>/settings.json` for the app-owned runtime scope. Isolated providers load it
// as their user settings; shared mode injects it through the SDK's highest-priority settings option.
// Two things are enforced here, preserving unrelated settings already present: the permissions.deny
// guard rules (file-tool fence, plus the current DENIED_BUILTIN_TOOLS,
// after pruning any stale module-owned MANAGED_BUILTIN_TOOLS entries), and disableBundledSkills so
// Claude Code's own bundled skills/workflows (dataviz, deep-research, …) never leak in — the app
// injects its OWN curated skill set into `<configDir>/skills`, which disableBundledSkills leaves
// untouched.
export type ClaudeRuntimeModelConfig = Readonly<{
  availableModels: readonly string[]
  modelOverrides: Readonly<Record<string, string>>
}>

const writeAppSettings = async (
  configDir: string,
  modelConfig?: ClaudeRuntimeModelConfig | null
): Promise<void> => {
  const settingsPath = join(configDir, 'settings.json')

  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null) settings = parsed as Record<string, unknown>
  } catch {
    settings = {}
  }

  const permissions =
    typeof settings.permissions === 'object' && settings.permissions !== null
      ? (settings.permissions as Record<string, unknown>)
      : {}
  const existingDeny = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : []
  // Drop any module-owned built-in deny entries first so a tool dropped from DENIED_BUILTIN_TOOLS is
  // actually re-enabled on upgrade, then re-add only the ones current policy still denies.
  const managed = new Set<string>(MANAGED_BUILTIN_TOOLS)
  const preservedDeny = existingDeny.filter((rule) => !managed.has(rule))
  const deny = [
    ...new Set([...preservedDeny, ...configDenyRules(configDir), ...DENIED_BUILTIN_TOOLS])
  ]

  settings.permissions = { ...permissions, deny }
  settings.disableBundledSkills = true
  // Module-owned hook, managed exactly like the deny rules: prune whatever this module wrote in an earlier
  // version, then add the current command, leaving every third-party hook in the file untouched. Without the
  // prune an older command would linger next to the new one and run twice.
  const existingHooks =
    typeof settings.hooks === 'object' && settings.hooks !== null
      ? (settings.hooks as Record<string, unknown>)
      : {}
  const existingPostToolUse = Array.isArray(existingHooks.PostToolUse)
    ? (existingHooks.PostToolUse as unknown[])
    : []
  const managedHooks = skillUsageHookSettings(configDir, process.platform)
  // Same declarative treatment for the PreToolUse path guard: prune what this module wrote in an
  // earlier version, then add the current entry.
  const existingPreToolUse = Array.isArray(existingHooks.PreToolUse)
    ? (existingHooks.PreToolUse as unknown[])
    : []
  const managedPreToolUse = pathGuardHookSettings(configDir, process.platform)
    .PreToolUse as unknown[]
  settings.hooks = {
    ...existingHooks,
    PreToolUse: [
      ...existingPreToolUse.filter((entry) => !isPathGuardHookEntry(entry)),
      ...managedPreToolUse
    ],
    PostToolUse: [
      ...existingPostToolUse.filter((entry) => !isSkillUsageHookEntry(entry)),
      ...(managedHooks.PostToolUse as unknown[])
    ]
  }
  if (modelConfig !== undefined) {
    if (modelConfig) {
      settings.availableModels = [...modelConfig.availableModels]
      settings.modelOverrides = { ...modelConfig.modelOverrides }
    } else {
      delete settings.availableModels
      delete settings.modelOverrides
    }
  }
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

type ProvisionOptions = {
  // The full skill catalog (featured + imported + personal). Defaults to bundled skills only.
  skills?: BundledSkill[]
  materializer?: SkillMaterializer
  disabledSkillIds?: string[]
  // `undefined` preserves the existing projection (validation probes must not perturb a live
  // backend); `null` explicitly clears a catalog owned by a previously active provider.
  modelConfig?: ClaudeRuntimeModelConfig | null
  // Folders the agent's tool calls may reach (data root, config root). The path-guard hook reads them
  // from beside its script; empty means the guard only allows the system temp dir, so callers that
  // know the install's roots must pass them.
  allowedRoots?: readonly string[]
  // Named in the refusal so the agent knows where this project's files actually are.
  allowedRootsHint?: string
}

// Ensures the app config dir + asset subdirs exist, writes the file-tool deny rules, then materializes
// the enabled skill set into `<configDir>/skills`. Idempotent and safe to call before each agent spawn.
// Skill materialization failures are swallowed by the materializer so a bad skill never blocks the spawn.
const provisionAppClaudeConfigDir = async (
  configDir: string,
  options: ProvisionOptions = {}
): Promise<void> => {
  await mkdir(configDir, { recursive: true })
  await Promise.all(
    [...APP_ASSET_SUBDIRS, APP_PLUGIN_MANIFEST_DIR].map((sub) =>
      mkdir(join(configDir, sub), { recursive: true })
    )
  )
  await writeFile(
    join(configDir, APP_PLUGIN_MANIFEST_DIR, 'plugin.json'),
    `${JSON.stringify({ name: 'purescience' }, null, 2)}\n`,
    'utf8'
  )

  await writeAppSettings(configDir, options.modelConfig)
  // The capture the managed hook invokes lives beside the settings that reference it, so both are written
  // from the same source of truth on every provision.
  await writeSkillUsageCapture(configDir)
  // Same for the path guard: the script and the roots it enforces are written together, so the fence
  // always describes the install it belongs to.
  await writePathGuard(configDir, options.allowedRoots ?? [], options.allowedRootsHint)

  const materializer = options.materializer ?? new ClaudeCodeSkillMaterializer()
  const skills = options.skills ?? (await new SkillRegistry().list())
  const disabled = new Set(options.disabledSkillIds ?? [])
  const enabled = skills.filter((skill) => !disabled.has(skill.id))

  await materializer.sync(configDir, enabled)
}

export {
  APP_ASSET_SUBDIRS,
  DENIED_BUILTIN_TOOLS,
  MANAGED_BUILTIN_TOOLS,
  configDenyRules,
  provisionAppClaudeConfigDir
}
