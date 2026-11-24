import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildHermesConfigYaml, hermesFramework, hermesStorageDir } from './hermes'
import type { ResolvedProvider } from '../settings/provider-env'

const provider = (extra: Partial<ResolvedProvider> = {}): ResolvedProvider =>
  ({
    type: 'custom',
    model: 'gpt-oss-120b',
    key: 'sk-test-key',
    baseUrl: 'https://api.example.com/v1',
    ...extra
  }) as ResolvedProvider

describe('hermesFramework', () => {
  it('is registered under the hermes id and speaks OpenAI-compatible endpoints only', () => {
    expect(hermesFramework.id).toBe('hermes')
    expect(hermesFramework.displayName).toBe('Hermes')
    expect(hermesFramework.supportedApiTypes).toEqual(['openai'])
    // Neither MCP flag is claimed: the measured initialize result carries no mcpCapabilities, so the app's
    // tools cannot be assumed reachable. docs/evidence/2026-11-24-hermes-acp-handshake.md
    expect(hermesFramework.acceptsStdioMcp).toBe(false)
    expect(hermesFramework.acceptsHttpMcp).toBe(false)
    expect(hermesFramework.supportsSkills).toBe(false)
    // No compaction command was measured on this build, so none is claimed.
    expect(hermesFramework.contextCompaction).toEqual({ kind: 'framework-managed' })
  })

  it('refuses a provider without an OpenAI-compatible base URL, key, or model', () => {
    expect(() =>
      hermesFramework.prepareModelConfig(
        { type: 'custom', model: 'm', key: 'k' } as ResolvedProvider,
        {
          storageRoot: '/data',
          executablePath: '/bin/hermes'
        }
      )
    ).toThrow(/OpenAI-compatible base URL/)
    expect(() =>
      hermesFramework.prepareModelConfig(provider({ key: '' }), {
        storageRoot: '/data',
        executablePath: '/bin/hermes'
      })
    ).toThrow(/OpenAI-compatible base URL/)
  })

  it('keeps the data root inside app storage and the credential out of the generated file', () => {
    const config = hermesFramework.prepareModelConfig(provider(), {
      storageRoot: '/data/root',
      executablePath: '/bin/hermes'
    })

    expect(config.env?.HERMES_HOME).toBe(join('/data/root', 'hermes'))
    expect(config.env?.HERMES_ACP_SKIP_CONFIGURED_MCP).toBe('1')
    expect(config.env?.OPENAI_API_KEY).toBe('sk-test-key')
    expect(config.env?.OPENAI_BASE_URL).toBe('https://api.example.com/v1')
    expect(config.configFiles).toHaveLength(1)

    const file = config.configFiles![0]
    expect(file.path).toBe(join('/data/root/hermes', 'config.yaml'))
    expect(file.mode).toBe(0o600)
    // Measured 2026-11-24 against a loopback fixture: a prompt turn completes with the key supplied
    // through OPENAI_API_KEY alone, so plaintext must never land in the file.
    expect(file.content).not.toContain('sk-test-key')
    expect(file.content).not.toContain('api_key')
  })

  it('writes a custom-provider config.yaml without an agent.system_prompt field', () => {
    const yaml = buildHermesConfigYaml(provider({ model: "oss'120b" }))

    expect(yaml).toContain("provider: 'custom'")
    expect(yaml).toContain("default: 'oss''120b'")
    expect(yaml).toContain("base_url: 'https://api.example.com/v1'")
    expect(yaml).toContain("api_mode: 'chat_completions'")
    expect(yaml).toContain('mcp_servers: {}')
    expect(yaml).toContain('memory_enabled: false')
    // In Hermes agent.system_prompt carries rendered personality text and its own migrations scrub it, so
    // app guidance goes through the ACP prompt path instead.
    expect(yaml).not.toContain('system_prompt')
  })

  it('carries app guidance as a prompt prefix, not as session meta this framework does not expose', () => {
    const setup = hermesFramework.buildSessionSetup({
      systemPromptAppends: ['artifact routing lives here'],
      turnPromptReminders: ['remember the notebook']
    })

    expect(setup.meta).toBeUndefined()
    expect(setup.promptPrefix).toContain('artifact routing lives here')
    expect(setup.promptPrefix).toContain('remember the notebook')
    expect(setup.persistentSystemPrompt).toBeUndefined()
  })

  it('never targets the user own ~/.hermes', () => {
    const root = hermesStorageDir('/data/root')

    expect(root).toBe(join('/data/root', 'hermes'))
    expect(root).not.toContain('.hermes')
  })
})
