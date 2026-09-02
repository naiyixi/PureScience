import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { codeBuddyFramework, codeBuddyStorageDir } from './codebuddy'

describe('codeBuddyFramework', () => {
  it('is registered under the codebuddy id with openai-only endpoints', () => {
    expect(codeBuddyFramework.id).toBe('codebuddy')
    expect(codeBuddyFramework.displayName).toBe('CodeBuddy')
    expect(codeBuddyFramework.supportedApiTypes).toEqual(['openai'])
    expect(codeBuddyFramework.supportsSkills).toBe(false)
    expect(codeBuddyFramework.acceptsStdioMcp).toBe(true)
    expect(codeBuddyFramework.supportsLiveEffortChange).toBe(true)
    expect(codeBuddyFramework.contextCompaction).toEqual({
      kind: 'native-command',
      command: '/compact',
      triggerAtPercent: 90
    })
  })

  it('throws when the provider lacks an OpenAI-compatible base URL', () => {
    expect(() =>
      codeBuddyFramework.prepareModelConfig(
        { type: 'custom', model: 'm', key: 'k' },
        { storageRoot: '/data', executablePath: '/bin/codebuddy' }
      )
    ).toThrow(/OpenAI-compatible base URL/)
  })

  it('writes isolated models.json/settings.json with env-ref keys, never plaintext', () => {
    const config = codeBuddyFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/codebuddy' }
    )

    const dir = codeBuddyStorageDir('/data')
    expect(config.env?.CODEBUDDY_CONFIG_DIR).toBe(dir)
    expect(config.env?.CODEBUDDY_API_KEY).toBe('k')
    expect(config.env?.CODEBUDDY_BASE_URL).toBe('https://gw/v1')
    expect(config.env?.CODEBUDDY_MODEL).toBe('m')

    const modelsFile = config.configFiles?.find((file) => file.path.endsWith('models.json'))
    expect(modelsFile?.mode).toBe(0o600)
    const models = JSON.parse(modelsFile?.content ?? '{}')
    expect(models.models[0].apiKey).toBe('${PURESCIENCE_CODEBUDDY_API_KEY}')
    expect(models.models[0].url).toBe('${PURESCIENCE_CODEBUDDY_CHAT_COMPLETIONS_URL}')
    expect(JSON.stringify(models)).not.toContain('"k"')

    const settingsFile = config.configFiles?.find((file) => file.path.endsWith('settings.json'))
    expect(settingsFile?.mode).toBe(0o600)
    const settings = JSON.parse(settingsFile?.content ?? '{}')
    expect(settings.autoCompactEnabled).toBe(false)
    expect(settings.permissions.deny).toEqual(['WebFetch', 'WebSearch'])
    // Sandbox is enabled everywhere except Windows (CodeBuddy's native sandbox is POSIX-only).
    expect(settings.sandbox.enabled).toBe(process.platform !== 'win32')
  })

  it('denies network tools via args and keeps local tools only', () => {
    const config = codeBuddyFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      { storageRoot: '/data', executablePath: '/bin/codebuddy' }
    )

    const toolsIndex = config.args?.indexOf('--tools')
    expect(config.args?.[(toolsIndex ?? 0) + 1]).toBe('Read,Write,Edit,Glob,Grep')
    const disallowedIndex = config.args?.indexOf('--disallowedTools')
    expect(config.args?.slice((disallowedIndex ?? 0) + 1)).toContain('Bash(curl:*)')
    expect(config.args?.slice((disallowedIndex ?? 0) + 1)).toContain('Bash(git clone:*)')
  })

  it('writes the system prompt file and passes it via --system-prompt-file', () => {
    const config = codeBuddyFramework.prepareModelConfig(
      { type: 'custom', baseUrl: 'https://gw/v1', model: 'm', key: 'k' },
      {
        storageRoot: '/data',
        executablePath: '/bin/codebuddy',
        systemPromptAppends: ['Use notebook routing.', 'Then write artifacts.']
      }
    )

    const promptFile = config.configFiles?.find((file) => file.path.endsWith('system-prompt.md'))
    expect(promptFile?.content).toBe('Use notebook routing.\n\nThen write artifacts.')
    const flagIndex = config.args?.indexOf('--system-prompt-file')
    expect(config.args?.[(flagIndex ?? 0) + 1]).toBe(
      join(codeBuddyStorageDir('/data'), 'system-prompt.md')
    )
    expect(config.persistentSystemPrompt).toBe(promptFile?.content)
  })

  it('builds session setup from appends and turn reminders', () => {
    const setup = codeBuddyFramework.buildSessionSetup({
      systemPromptAppends: ['append one'],
      turnPromptReminders: ['remind me']
    })
    expect(setup.promptPrefix).toContain('append one')
    expect(setup.promptPrefix).toContain('remind me')
  })
})
