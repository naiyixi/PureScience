import { describe, expect, it } from 'vitest'

import {
  DEEPSEEK_HARNESS_CLI,
  PI_ACP_CLI,
  collectCandidateDirs,
  detectAgentCli,
  parseVersion,
  type AgentCliDetectDeps
} from './agent-cli-detect'

const deps = (over: Partial<AgentCliDetectDeps> = {}): AgentCliDetectDeps => ({
  env: { PATH: '/usr/bin' },
  homePath: '/home/u',
  platform: 'darwin',
  isExecutable: async () => false,
  getVersion: async () => undefined,
  ...over
})

describe('agent CLI detector', () => {
  it('reads a bare semver and tolerates a v prefix', () => {
    expect(parseVersion('0.1.27\n')).toBe('0.1.27')
    expect(parseVersion('v0.0.35')).toBe('0.0.35')
    expect(parseVersion('usage: whatever')).toBeUndefined()
  })

  it('finds the binary in an npm global dir a GUI process never has on PATH', async () => {
    const found = await detectAgentCli(DEEPSEEK_HARNESS_CLI, {
      ...deps(),
      isExecutable: async (candidate) => candidate === '/opt/homebrew/bin/deepseek-harness-acp',
      getVersion: async () => '0.1.27'
    })

    expect(found).toEqual({
      resolvedPath: '/opt/homebrew/bin/deepseek-harness-acp',
      version: '0.1.27'
    })
  })

  it('accepts the dsh-acp alias the server documents in its own --help', async () => {
    const found = await detectAgentCli(DEEPSEEK_HARNESS_CLI, {
      ...deps(),
      isExecutable: async (candidate) => candidate.endsWith('/dsh-acp'),
      getVersion: async () => '0.1.27'
    })

    expect(found?.resolvedPath.endsWith('/dsh-acp')).toBe(true)
  })

  it('keeps looking when a binary exists but reports no version', async () => {
    const found = await detectAgentCli(DEEPSEEK_HARNESS_CLI, {
      ...deps(),
      isExecutable: async (candidate) => candidate.endsWith('deepseek-harness-acp'),
      getVersion: async () => undefined
    })

    expect(found).toBeUndefined()
  })

  it('accepts pi-acp without a version, because --version prints nothing and exits 0', async () => {
    const found = await detectAgentCli(PI_ACP_CLI, {
      ...deps(),
      isExecutable: async (candidate) => candidate === '/opt/homebrew/bin/pi-acp',
      getVersion: async () => undefined
    })

    expect(found).toEqual({ resolvedPath: '/opt/homebrew/bin/pi-acp' })
  })

  it('tries .cmd before the extension-less name on Windows', () => {
    const dirs = collectCandidateDirs(
      {
        env: { PATH: '', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
        homePath: 'C:\\Users\\u',
        platform: 'win32',
        isExecutable: async () => false,
        getVersion: async () => undefined
      },
      PI_ACP_CLI
    )

    expect(dirs).toContain('C:\\Users\\u\\AppData\\Roaming\\npm')
  })
})
