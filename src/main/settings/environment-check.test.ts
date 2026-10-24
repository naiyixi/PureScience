import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  runEnvironmentCheck,
  verifyStorageAccess,
  type EnvironmentCheckDeps
} from './environment-check'

const baseDeps = (): EnvironmentCheckDeps => ({
  platform: 'darwin' as const,
  architecture: 'arm64',
  verifyStorage: vi.fn().mockResolvedValue(undefined),
  resolveManagedPlatform: vi.fn().mockReturnValue({ key: 'darwin-arm64' }),
  findPython: vi.fn().mockResolvedValue({ command: 'python3', baseArgs: [] }),
  probeRegistry: vi.fn(async (registry: 'npmjs' | 'npmmirror') =>
    registry === 'npmmirror' ? 42 : 380
  ),
  now: () => 1234
})

describe('runEnvironmentCheck', () => {
  it('probes the codex-acp package when Codex is selected', async () => {
    const probeRegistry = vi.fn().mockResolvedValue(20)

    await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'codex',
      frameworks: [{ id: 'codex', label: 'Codex', runtime: { found: false } }],
      encryptionAvailable: true,
      deps: { ...baseDeps(), probeRegistry }
    })

    expect(probeRegistry).toHaveBeenCalledTimes(2)
    expect(probeRegistry.mock.calls.map((call) => call[1])).toEqual([
      '/@agentclientprotocol%2fcodex-acp/latest',
      '/@agentclientprotocol%2fcodex-acp/latest'
    ])
  })

  it('selects the fastest reachable trusted registry for a missing runtime', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [{ id: 'claude-code' as const, label: 'Claude', runtime: { found: false } }],
      encryptionAvailable: true,
      deps: baseDeps()
    })

    expect(result.recommendedRegistry).toBe('npmmirror')
    expect(result.canAutoInstall).toBe(true)
    expect(result.ready).toBe(false)
    expect(result.checks.find((check) => check.id === 'install-network')).toMatchObject({
      status: 'passed',
      summary: expect.stringContaining('npmmirror')
    })
  })

  it('blocks automatic installation when both trusted registries are unreachable', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [{ id: 'claude-code' as const, label: 'Claude', runtime: { found: false } }],
      encryptionAvailable: true,
      deps: { ...baseDeps(), probeRegistry: vi.fn().mockRejectedValue(new Error('offline')) }
    })

    expect(result.recommendedRegistry).toBeUndefined()
    expect(result.canAutoInstall).toBe(false)
    expect(result.checks.find((check) => check.id === 'install-network')).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('Neither the official registry')
    })
  })

  it('checks both frameworks but gates only on the selected one', async () => {
    // Claude installed, OpenCode not — with OpenCode selected, its absence blocks (failed) while the
    // installed Claude row is informational (passed); the non-selected missing case is a warning.
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'opencode' as const,
      frameworks: [
        {
          id: 'claude-code' as const,
          label: 'Claude',
          runtime: { found: true, path: '/bin/claude', version: '2.1.0' }
        },
        { id: 'opencode' as const, label: 'OpenCode', runtime: { found: false } }
      ],
      encryptionAvailable: true,
      deps: baseDeps()
    })

    const rows = result.checks.filter((check) => check.id === 'agent')
    expect(rows.map((row) => `${row.label}:${row.status}`)).toEqual([
      'Claude runtime:passed',
      'OpenCode runtime:failed'
    ])
    // Selected (OpenCode) missing → not ready, and it can be auto-installed.
    expect(result.ready).toBe(false)
    expect(result.canAutoInstall).toBe(true)
    expect(result.runtime).toEqual({ found: false })
  })

  it('is ready when the selected framework is installed even if the other is missing', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [
        {
          id: 'claude-code' as const,
          label: 'Claude',
          runtime: { found: true, path: '/bin/claude', version: '2.1.0' }
        },
        { id: 'opencode' as const, label: 'OpenCode', runtime: { found: false } }
      ],
      encryptionAvailable: true,
      deps: baseDeps()
    })

    const opencodeRow = result.checks.find((check) => check.label === 'OpenCode runtime')
    // The non-selected missing framework is an informational warning, not a blocker.
    expect(opencodeRow?.status).toBe('warning')
    expect(result.ready).toBe(true)
  })

  it('notes the baseline build for a non-AVX2 x64 opencode host while staying auto-installable', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'opencode' as const,
      frameworks: [{ id: 'opencode' as const, label: 'OpenCode', runtime: { found: false } }],
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        platform: 'linux' as const,
        architecture: 'x64',
        resolveManagedPlatform: vi.fn().mockReturnValue({ key: 'linux-x64' }),
        detectAvx2: () => false
      }
    })

    const system = result.checks.find((check) => check.id === 'system')
    // Passed (not a warning) with an informational baseline note — the true capability.
    expect(system?.status).toBe('passed')
    expect(system?.summary).toContain('baseline build')
    expect(system?.detail).toContain('AVX2')
    // A non-AVX2 x64 host is still fully auto-installable via the baseline package.
    expect(result.canAutoInstall).toBe(true)
  })

  it('blocks automatic setup when the app data directory is not writable', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/locked',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [{ id: 'claude-code' as const, label: 'Claude', runtime: { found: false } }],
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        verifyStorage: vi.fn().mockRejectedValue(new Error('EACCES'))
      }
    })

    expect(result.canAutoInstall).toBe(false)
    expect(result.checks.find((check) => check.id === 'storage')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('EACCES')
    })
  })

  it('reports an available Python interpreter as an optional ready capability', async () => {
    const probeRegistry = vi.fn()
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [
        {
          id: 'claude-code' as const,
          label: 'Claude',
          runtime: { found: true, path: '/bin/claude', version: '2.1.0' }
        }
      ],
      encryptionAvailable: true,
      deps: { ...baseDeps(), probeRegistry }
    })

    expect(probeRegistry).not.toHaveBeenCalled()
    expect(result.checks.find((check) => check.id === 'install-network')?.status).toBe('passed')
    expect(result.checks.find((check) => check.id === 'python')).toMatchObject({
      status: 'passed',
      detail: 'python3'
    })
    expect(result.ready).toBe(true)
    expect(result.canAutoInstall).toBe(false)
  })

  it('treats a missing system Python as optional (notebooks use the app-managed environment)', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [
        {
          id: 'claude-code' as const,
          label: 'Claude',
          runtime: { found: true, path: '/bin/claude', version: '2.1.0' }
        }
      ],
      encryptionAvailable: true,
      deps: { ...baseDeps(), findPython: vi.fn().mockResolvedValue(undefined) }
    })

    // Notebooks use the app-managed environment, so a missing system Python 3 is optional (passed),
    // not an amber warning that implies the notebook feature is broken.
    expect(result.checks.find((check) => check.id === 'python')).toMatchObject({
      status: 'passed',
      summary: expect.stringContaining('app-managed Python environment')
    })
    expect(result.ready).toBe(true)
  })

  it('warns without blocking keyless setup when secure credential storage is unavailable', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [
        {
          id: 'claude-code' as const,
          label: 'Claude',
          runtime: { found: true, path: '/bin/claude' }
        }
      ],
      encryptionAvailable: false,
      deps: baseDeps()
    })

    expect(result.checks.find((check) => check.id === 'secure-storage')?.status).toBe('warning')
    expect(result.ready).toBe(true)
  })

  it('blocks automatic installation on an unsupported platform when no runtime exists', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [{ id: 'claude-code' as const, label: 'Claude', runtime: { found: false } }],
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        platform: 'freebsd' as NodeJS.Platform,
        architecture: 'x64',
        resolveManagedPlatform: () => {
          throw new Error('Unsupported platform for managed install')
        }
      }
    })

    expect(result.canAutoInstall).toBe(false)
    expect(result.checks.find((check) => check.id === 'system')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('Unsupported platform')
    })
  })

  it('keeps an existing runtime usable when only the managed installer is unsupported', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [
        {
          id: 'claude-code' as const,
          label: 'Claude',
          runtime: { found: true, path: '/opt/claude', version: '2.1.0' }
        }
      ],
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        platform: 'freebsd' as NodeJS.Platform,
        resolveManagedPlatform: () => {
          throw new Error('Unsupported platform for managed install')
        }
      }
    })

    expect(result.checks.find((check) => check.id === 'system')?.status).toBe('warning')
    expect(result.ready).toBe(true)
  })

  it('verifies a real writable data directory without leaving probe files behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-environment-check-'))

    try {
      await verifyStorageAccess(root)
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses diagnostic message when runtime detection provides one', async () => {
    const diagnosticMessage =
      'Native Codex 0.144.2 is installed at /Applications/ChatGPT.app/Contents/Resources/codex, but the Codex ACP adapter required by PureScience is missing.'

    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'codex',
      frameworks: [
        {
          id: 'codex',
          label: 'Codex',
          runtime: { found: false, diagnostic: diagnosticMessage }
        }
      ],
      encryptionAvailable: true,
      deps: baseDeps()
    })

    const codexCheck = result.checks.find(
      (check) => check.id === 'agent' && check.label === 'Codex runtime'
    )
    expect(codexCheck?.status).toBe('failed')
    expect(codexCheck?.summary).toBe(diagnosticMessage)
    expect(codexCheck?.detail).toBeUndefined()
  })

  it('falls back to generic message when no diagnostic is provided', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'codex',
      frameworks: [{ id: 'codex', label: 'Codex', runtime: { found: false } }],
      encryptionAvailable: true,
      deps: baseDeps()
    })

    const codexCheck = result.checks.find(
      (check) => check.id === 'agent' && check.label === 'Codex runtime'
    )
    expect(codexCheck?.status).toBe('failed')
    expect(codexCheck?.summary).toBe('Codex is not installed yet.')
    expect(codexCheck?.detail).toBe(
      'Automatic setup installs a self-contained runtime without Node.js, npm, or admin access.'
    )
  })

  it('displays separate rows for Codex native CLI and adapter when component info is available', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'codex',
      frameworks: [
        {
          id: 'codex',
          label: 'Codex',
          runtime: {
            found: false,
            codexComponents: {
              nativeCliFound: true,
              nativeCliPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
              nativeCliVersion: '0.144.2',
              adapterFound: false,
              adapterPath: undefined,
              adapterVersion: undefined
            }
          }
        }
      ],
      encryptionAvailable: true,
      deps: baseDeps()
    })

    const nativeCheck = result.checks.find((check) => check.label === 'Codex native CLI')
    const adapterCheck = result.checks.find((check) => check.label === 'Codex ACP adapter')

    expect(nativeCheck).toMatchObject({
      id: 'agent',
      label: 'Codex native CLI',
      status: 'passed',
      summary: 'Codex CLI 0.144.2 is installed.',
      detail: '/Applications/ChatGPT.app/Contents/Resources/codex'
    })

    expect(adapterCheck).toMatchObject({
      id: 'agent',
      label: 'Codex ACP adapter',
      status: 'failed',
      summary: 'Codex ACP adapter is not installed.',
      detail: undefined
    })
  })

  it('omits the version when a paired native CLI has no resolvable version', async () => {
    // Regression (spec P2): a paired external adapter can set nativeCliFound=true without a version
    // (the path probe missed the binary but the handshake proved it works). The summary must not
    // render "Codex CLI undefined is installed."
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'codex',
      frameworks: [
        {
          id: 'codex',
          label: 'Codex',
          runtime: {
            found: true,
            codexComponents: {
              nativeCliFound: true,
              nativeCliPath: undefined,
              nativeCliVersion: undefined,
              adapterFound: true,
              adapterPath: '/opt/tools/codex-acp',
              adapterVersion: '1.1.4'
            }
          }
        }
      ],
      encryptionAvailable: true,
      deps: baseDeps()
    })

    const nativeCheck = result.checks.find((check) => check.label === 'Codex native CLI')
    expect(nativeCheck?.status).toBe('passed')
    expect(nativeCheck?.summary).toBe('Codex CLI is installed.')
  })

  it('shows both Codex components as passed when both are found', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'codex',
      frameworks: [
        {
          id: 'codex',
          label: 'Codex',
          runtime: {
            found: true,
            path: '/usr/local/bin/codex-acp',
            version: '1.0.0',
            codexComponents: {
              nativeCliFound: true,
              nativeCliPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
              nativeCliVersion: '0.144.2',
              adapterFound: true,
              adapterPath: '/usr/local/bin/codex-acp',
              adapterVersion: '1.0.0'
            }
          }
        }
      ],
      encryptionAvailable: true,
      deps: baseDeps()
    })

    const nativeCheck = result.checks.find((check) => check.label === 'Codex native CLI')
    const adapterCheck = result.checks.find((check) => check.label === 'Codex ACP adapter')

    expect(nativeCheck).toMatchObject({
      status: 'passed',
      summary: 'Codex CLI 0.144.2 is installed.'
    })

    expect(adapterCheck).toMatchObject({
      status: 'passed',
      summary: 'Codex ACP adapter 1.0.0 is ready.'
    })
  })

  it('marks non-selected Codex components as warnings when missing', async () => {
    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code',
      frameworks: [
        {
          id: 'claude-code',
          label: 'Claude',
          runtime: { found: true, path: '/usr/local/bin/claude', version: '2.1.0' }
        },
        {
          id: 'codex',
          label: 'Codex',
          runtime: {
            found: false,
            codexComponents: {
              nativeCliFound: false,
              adapterFound: false
            }
          }
        }
      ],
      encryptionAvailable: true,
      deps: baseDeps()
    })

    const nativeCheck = result.checks.find((check) => check.label === 'Codex native CLI')
    const adapterCheck = result.checks.find((check) => check.label === 'Codex ACP adapter')

    expect(nativeCheck?.status).toBe('warning')
    expect(adapterCheck?.status).toBe('warning')
    expect(result.ready).toBe(true) // Non-selected framework doesn't block
  })

  // The packaged build logged this handler as slow 17 times (median 5.3 s, max 42.2 s) and the line named
  // no phase, so the number could not be acted on. These three cases pin the names a slow answer must be
  // attributable to — and that recording them changes neither the answer nor which phases run.
  it('names every phase it waited on, without changing the answer', async () => {
    const recorded: string[] = []
    const record = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
      recorded.push(name)
      return run()
    }
    const request = {
      storageRoot: '/data',
      agentFrameworkId: 'claude-code' as const,
      frameworks: [
        { id: 'claude-code' as const, label: 'Claude', runtime: { found: false as const } }
      ],
      encryptionAvailable: true
    }

    const unrecorded = await runEnvironmentCheck({ ...request, deps: baseDeps() })
    const attributed = await runEnvironmentCheck({
      ...request,
      deps: { ...baseDeps(), recordStep: record }
    })

    expect(recorded).toEqual(['verify-storage', 'find-python', 'probe-npmjs', 'probe-npmmirror'])
    // Attribution is an observation: the answer itself must be byte-identical to the unrecorded run.
    expect(attributed).toEqual(unrecorded)
  })

  it('does not record a registry probe at all when the selected runtime is already installed', async () => {
    const recorded: string[] = []

    await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code',
      frameworks: [
        { id: 'claude-code', label: 'Claude', runtime: { found: true, path: '/bin/claude' } }
      ],
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        recordStep: (name, run) => {
          recorded.push(name)
          return Promise.resolve().then(run)
        }
      }
    })

    // No download is needed, so no probe may appear in the record — a step that never ran must not be
    // timed, or the summary would claim a phase the caller never paid for.
    expect(recorded).toEqual(['verify-storage', 'find-python'])
  })

  it('records a storage failure as a failed step and still reports it on the check', async () => {
    const outcomes: { name: string; outcome: string }[] = []

    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code',
      frameworks: [
        { id: 'claude-code', label: 'Claude', runtime: { found: true, path: '/bin/claude' } }
      ],
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        verifyStorage: vi.fn().mockRejectedValue(new Error('EACCES')),
        recordStep: async (name, run) => {
          try {
            const value = await run()
            outcomes.push({ name, outcome: 'ok' })
            return value
          } catch (error) {
            outcomes.push({ name, outcome: 'failed' })
            throw error
          }
        }
      }
    })

    // Recording must not swallow the failure: the step is named as failed AND the item still says so.
    expect(outcomes).toContainEqual({ name: 'verify-storage', outcome: 'failed' })
    expect(result.checks.find((check) => check.id === 'storage')).toMatchObject({
      status: 'failed'
    })
    expect(result.canAutoInstall).toBe(false)
  })

  it('an unreachable registry stays a result rather than a failed step', async () => {
    const outcomes: { name: string; outcome: string }[] = []

    const result = await runEnvironmentCheck({
      storageRoot: '/data',
      agentFrameworkId: 'claude-code',
      frameworks: [{ id: 'claude-code', label: 'Claude', runtime: { found: false } }],
      encryptionAvailable: true,
      deps: {
        ...baseDeps(),
        probeRegistry: vi.fn().mockRejectedValue(new Error('Timed out')),
        recordStep: async (name, run) => {
          try {
            const value = await run()
            outcomes.push({ name, outcome: 'ok' })
            return value
          } catch (error) {
            outcomes.push({ name, outcome: 'failed' })
            throw error
          }
        }
      }
    })

    // Both probes are expected to be able to fail — that is what the check compares — so neither may be
    // reported as a failed step; the network item carries the verdict instead.
    expect(outcomes.filter((entry) => entry.name.startsWith('probe-'))).toEqual([
      { name: 'probe-npmjs', outcome: 'ok' },
      { name: 'probe-npmmirror', outcome: 'ok' }
    ])
    expect(result.checks.find((check) => check.id === 'install-network')?.status).toBe('failed')
  })
})
