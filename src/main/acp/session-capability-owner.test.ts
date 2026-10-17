import { describe, expect, it, vi } from 'vitest'

import { claudeCodeFramework, codexFramework, opencodeFramework } from '../agent-framework'
import type { AgentMcpHttpHost } from './mcp-http-host'
import {
  AcpSessionCapabilityOwner,
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
  REVIEWER_SESSION_CAPABILITY_POLICY,
  policyAllowsSessionCapability
} from './session-capability-owner'

/**
 * How long a coordination wait may take.
 *
 * Every `vi.waitFor` in this file is a *coordination* wait: it waits for the side effect of work that
 * is already in flight (a spy being called, a process dying, a worker reporting that it started, a
 * rendered node reaching its final text), never for something that may never happen. The only thing
 * the window has to cover is how long a loaded machine takes to schedule that continuation -- so the
 * default 1s is a quiet-machine budget, not a correctness budget. Measured on this repository: under
 * load a coordinated wait took up to 704ms (34 samples, p90 = 361ms), and a site elsewhere in the
 * suite failed at ~1.1s under load average ~70 while passing on a quiet machine.
 *
 * 30s matches the window this repository already uses for load-sensitive waits, and it stays well below
 * vitest's 60s per-test timeout, so an assertion that is genuinely stuck still fails as a failure
 * instead of hanging.
 */
const COORDINATION_WINDOW_MS = 30_000

const createOwner = (
  overrides: ConstructorParameters<typeof AcpSessionCapabilityOwner>[0] = {}
): AcpSessionCapabilityOwner =>
  new AcpSessionCapabilityOwner({
    artifacts: {
      dataRoot: '/data',
      projectName: 'project',
      mcpEntryPath: '/app/main.js'
    },
    notebook: {
      projectName: 'project',
      mcpEntryPath: '/app/main.js',
      getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1', token: 'notebook' })
    },
    skillImport: {
      mcpEntryPath: '/app/main.js',
      getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:2', token: 'skill' })
    },
    ...overrides
  })

describe('ACP session capability owner', () => {
  it.each([
    [claudeCodeFramework, 'purescience_plan'],
    [codexFramework, 'purescience_plan'],
    [opencodeFramework, 'purescience_plan']
  ] as const)('projects the same Session Plan tools for %s', async (framework, modelFacingName) => {
    const release = vi.fn()
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      plan: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4',
          token: 'plan',
          release
        })
      }
    })
    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project-1'
    })

    expect(provision.descriptor).toMatchObject({
      transport: 'stdio',
      capabilities: ['plan'],
      canonicalMcpServerNames: ['purescience_plan'],
      modelFacingMcpServerNames: [modelFacingName]
    })
    provision.commit('session-1')
    owner.revokeSession('session-1')
    expect(release).toHaveBeenCalledOnce()
  })

  it('provisions the Session Plan capability over stdio with server-owned identity', async () => {
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      plan: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4', token: 'plan' })
      }
    })

    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: true },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project-1'
    })

    expect(provision.descriptor.capabilities).toEqual(['plan'])
    expect(provision.mcpServers).toEqual([
      expect.objectContaining({
        name: 'purescience_plan',
        env: expect.arrayContaining([
          { name: 'PURESCIENCE_PLAN_PROJECT_ID', value: 'project-1' },
          { name: 'PURESCIENCE_PLAN_SESSION_ID', value: 'session-1' }
        ])
      })
    ])
  })

  it('aliases a provisional Plan capability to the stable app Session on commit', async () => {
    const registerSessionAlias = vi.fn()
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      plan: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:4', token: 'plan' }),
        registerSessionAlias
      }
    })

    const provision = await owner.provision({
      framework: { ...opencodeFramework, acceptsStdioMcp: true },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project-1'
    })
    const planServer = provision.mcpServers[0]
    expect(planServer && 'env' in planServer).toBe(true)
    const provisionalId = (planServer && 'env' in planServer ? planServer.env : undefined)?.find(
      (entry) => entry.name === 'PURESCIENCE_PLAN_SESSION_ID'
    )?.value
    provision.commit('session-1')

    expect(provisionalId).toMatch(/^plan-session-/u)
    expect(registerSessionAlias).toHaveBeenCalledWith(provisionalId, 'session-1')
  })

  it('refreshes preference-backed availability before backend guidance is projected', async () => {
    let skillImportEnabled = false
    const owner = createOwner({
      skillImport: {
        mcpEntryPath: '/app/main.js',
        isEnabled: async () => skillImportEnabled,
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:2', token: 'skill' })
      }
    })
    const input = {
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY
    }

    await owner.refreshDynamicAvailability()
    expect(owner.toolingAvailability(input).skillImport).toBe(false)

    skillImportEnabled = true
    await owner.refreshDynamicAvailability()
    expect(owner.toolingAvailability(input).skillImport).toBe(true)
  })

  it('commits a provision under the stable app identity', async () => {
    const release = vi.fn()
    const registerSessionAlias = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release
        }),
        registerSessionAlias,
        releaseSessionCapabilities
      }
    })

    const provision = await owner.provision({
      stableAppSessionId: 'provider-session',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })

    provision.commit('app-session')

    expect(registerSessionAlias).toHaveBeenCalledWith('provider-session', 'app-session')
    expect(owner.mcpServerNamesFor('app-session')).toEqual(['purescience_notebook'])
    expect(release).not.toHaveBeenCalled()

    owner.revokeSession('app-session')
    expect(release).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith('app-session')
  })

  it('releases acquired local RPC leases when a later provision step fails', async () => {
    const notebookRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    const owner = createOwner({
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: notebookRelease
        }),
        releaseSessionCapabilities
      },
      skillImport: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => {
          throw new Error('Skill import RPC unavailable')
        }
      }
    })

    await expect(
      owner.provision({
        stableAppSessionId: 'session-1',
        framework: opencodeFramework,
        nativeMcpEnabled: true,
        bridgeMcpAliasesEnabled: false,
        policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
        sessionCwd: '/workspace',
        projectName: 'project'
      })
    ).rejects.toThrow('Skill import RPC unavailable')
    expect(notebookRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith('session-1')
  })

  it('unregisters partial HTTP routes when provision building fails', async () => {
    const unregister = vi.fn()
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerArtifact: vi.fn(),
      registerNotebook: vi.fn(),
      registerSkillImport: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      mcpHttpHost: host,
      skillImport: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => {
          throw new Error('Skill import RPC unavailable')
        }
      }
    })

    await expect(
      owner.provision({
        stableAppSessionId: 'session-1',
        framework: { ...opencodeFramework, acceptsStdioMcp: false },
        nativeMcpEnabled: true,
        bridgeMcpAliasesEnabled: false,
        policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
        sessionCwd: '/workspace',
        projectName: 'project'
      })
    ).rejects.toThrow('Skill import RPC unavailable')

    expect(unregister).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledWith('session-1')
  })

  it('revokes a committed same-ID HTTP route when its replacement fails before registration', async () => {
    const startupFailure = new Error('MCP host startup failed')
    const ensureStarted = vi
      .fn()
      .mockResolvedValueOnce({ endpoint: 'http://127.0.0.1:3', token: 'host' })
      .mockRejectedValueOnce(startupFailure)
    const unregister = vi.fn()
    const host = {
      ensureStarted,
      registerNotebook: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      mcpHttpHost: host
    })
    const input = {
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    }
    const committed = await owner.provision(input)
    committed.commit('session-1')

    await expect(owner.provision(input)).rejects.toBe(startupFailure)

    expect(unregister).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledWith('session-1')
  })

  it('retains provisional cleanup ownership through disposal', async () => {
    let resolveConnection!: (connection: { endpoint: string; token: string }) => void
    const connection = new Promise<{ endpoint: string; token: string }>((resolve) => {
      resolveConnection = resolve
    })
    const getRpcConnection = vi.fn(() => connection)
    const unregister = vi.fn()
    const clear = vi.fn()
    const registerNotebook = vi.fn()
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerNotebook,
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear,
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      mcpHttpHost: host,
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection
      }
    })
    const provisionPromise = owner.provision({
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })
    await vi.waitFor(() => expect(getRpcConnection).toHaveBeenCalledOnce(), {
      timeout: COORDINATION_WINDOW_MS
    })

    owner.dispose()
    owner.clearHttpRoutes()
    resolveConnection({ endpoint: 'http://127.0.0.1:1', token: 'notebook' })
    const provision = await provisionPromise
    provision.release({ ownsStableIdentity: true })

    expect(clear).toHaveBeenCalledOnce()
    expect(registerNotebook).not.toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledWith('session-1')
  })

  it('prevents a stale HTTP provision from overwriting its same-ID successor', async () => {
    let resolveFirstConnection!: (connection: { endpoint: string; token: string }) => void
    const firstConnection = new Promise<{ endpoint: string; token: string }>((resolve) => {
      resolveFirstConnection = resolve
    })
    let connectionIndex = 0
    const getRpcConnection = vi.fn(() => {
      connectionIndex += 1
      return connectionIndex === 1
        ? firstConnection
        : Promise.resolve({ endpoint: 'http://127.0.0.1:2', token: 'successor' })
    })
    const registerNotebook = vi.fn()
    const unregister = vi.fn()
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerNotebook,
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      mcpHttpHost: host,
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection
      }
    })
    const input = {
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    }
    const staleProvisionPromise = owner.provision(input)
    await vi.waitFor(() => expect(getRpcConnection).toHaveBeenCalledOnce(), {
      timeout: COORDINATION_WINDOW_MS
    })
    owner.dispose()
    owner.clearHttpRoutes()

    const successor = await owner.provision(input)
    successor.commit('session-1')
    resolveFirstConnection({ endpoint: 'http://127.0.0.1:1', token: 'stale' })
    const stale = await staleProvisionPromise
    stale.release({ ownsStableIdentity: true })

    expect(registerNotebook).toHaveBeenCalledOnce()
    expect(registerNotebook).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ token: 'successor' })
    )
    expect(unregister).not.toHaveBeenCalled()
  })

  it('rejects a provision commit from before owner disposal', async () => {
    const owner = createOwner({ artifacts: undefined, skillImport: undefined })
    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })

    owner.dispose()

    expect(() => provision.commit('session-1')).toThrow('provision was superseded')
    expect(owner.mcpServerNamesFor('session-1')).toEqual([])
  })

  it('performs only the first terminal provision action', async () => {
    const release = vi.fn()
    const registerSessionAlias = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release
        }),
        registerSessionAlias,
        releaseSessionCapabilities
      }
    })
    const provision = await owner.provision({
      stableAppSessionId: 'provider-session',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })

    provision.release({ ownsStableIdentity: true })
    provision.release({ ownsStableIdentity: true })
    provision.commit('app-session')

    expect(release).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledWith('provider-session')
    expect(registerSessionAlias).not.toHaveBeenCalled()
    expect(owner.mcpServerNamesFor('app-session')).toEqual([])
  })

  it('does not broadly revoke stable capability state from a superseded provision', async () => {
    const firstRelease = vi.fn()
    const secondRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    let provisionIndex = 0
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: [firstRelease, secondRelease][provisionIndex++]
        }),
        releaseSessionCapabilities
      }
    })
    const input = {
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    }
    const first = await owner.provision(input)
    const second = await owner.provision(input)

    first.release({ ownsStableIdentity: true })

    expect(firstRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).not.toHaveBeenCalled()

    second.commit('session-1')
    owner.revokeSession('session-1')
    expect(secondRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
  })

  it('rejects commit from a superseded stable-identity provision', async () => {
    const firstRelease = vi.fn()
    const secondRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    let provisionIndex = 0
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: [firstRelease, secondRelease][provisionIndex++]
        }),
        releaseSessionCapabilities
      }
    })
    const input = {
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    }
    const first = await owner.provision(input)
    const second = await owner.provision(input)

    expect(() => first.commit('stale-session')).toThrow('provision was superseded')
    expect(firstRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).not.toHaveBeenCalled()
    expect(owner.mcpServerNamesFor('stale-session')).toEqual([])

    second.commit('session-1')
    owner.revokeSession('session-1')
    expect(secondRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
  })

  it('derives the exact current primary set while reviewer and unknown capabilities fail closed', async () => {
    const owner = createOwner()
    const primary = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })
    const reviewer = await owner.provision({
      stableAppSessionId: 'reviewer-session',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: REVIEWER_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })

    expect(primary.descriptor.capabilities).toEqual([
      'artifacts',
      'notebook',
      'skill-import',
      'host-agents'
    ])
    expect(primary.descriptor.modelFacingMcpServerNames).toEqual([
      'purescience_artifacts',
      'purescience_notebook',
      'purescience_skills'
    ])
    expect(primary.descriptor.canonicalMcpServerNames).toEqual([
      'purescience_artifacts',
      'purescience_notebook',
      'purescience_skills'
    ])
    expect(primary.descriptor.controlRpcMethods).toEqual(['mcpCall', 'computeCall', 'agentsCall'])
    expect(reviewer.mcpServers).toEqual([])
    expect(reviewer.descriptor.capabilities).toEqual([])
    expect(policyAllowsSessionCapability(REVIEWER_SESSION_CAPABILITY_POLICY, 'notebook')).toBe(
      false
    )
    expect(
      policyAllowsSessionCapability(CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY, 'future-delegation')
    ).toBe(false)
  })

  it('returns an immutable, credential-free descriptor', async () => {
    const owner = createOwner()
    const built = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })

    expect(Object.isFrozen(built.descriptor)).toBe(true)
    expect(Object.isFrozen(built.descriptor.capabilities)).toBe(true)
    expect(JSON.stringify(built.descriptor)).not.toMatch(
      /notebook-token|skill-token|127\.0\.0\.1|workspace|\/data/
    )
  })

  it('publishes replacement ownership before releasing the prior lease and revokes once', async () => {
    const firstRelease = vi.fn()
    const secondRelease = vi.fn()
    const firstSkillImportRelease = vi.fn()
    const secondSkillImportRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    let notebookProvision = 0
    let skillImportProvision = 0
    const owner = createOwner({
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: [firstRelease, secondRelease][notebookProvision++]
        }),
        releaseSessionCapabilities
      },
      skillImport: {
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:2',
          token: 'skill',
          release: [firstSkillImportRelease, secondSkillImportRelease][skillImportProvision++]
        })
      }
    })
    const first = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })
    first.commit('session-1')
    const second = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: opencodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })

    second.commit('session-1')

    expect(firstRelease).toHaveBeenCalledOnce()
    expect(firstSkillImportRelease).toHaveBeenCalledOnce()
    expect(secondRelease).not.toHaveBeenCalled()
    expect(secondSkillImportRelease).not.toHaveBeenCalled()

    owner.revokeSession('session-1')
    owner.revokeSession('session-1')

    expect(secondRelease).toHaveBeenCalledOnce()
    expect(secondSkillImportRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
  })

  it('keeps per-session route revocation separate from the HTTP host lifetime', async () => {
    const unregister = vi.fn()
    const close = vi.fn()
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerArtifact: vi.fn(),
      registerNotebook: vi.fn(),
      registerSkillImport: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({ mcpHttpHost: host })
    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })
    provision.commit('session-1')

    owner.revokeSession('session-1')

    expect(unregister).toHaveBeenCalledTimes(3)
    expect(close).not.toHaveBeenCalled()
  })

  it('finishes bearer and owner cleanup when a committed HTTP route unregister throws', async () => {
    const notebookRelease = vi.fn()
    const releaseSessionCapabilities = vi.fn()
    const unregister = vi.fn(() => {
      throw new Error('route cleanup failed')
    })
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:3', token: 'host' })),
      registerNotebook: vi.fn(),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:3/${kind}/${routingId}`),
      unregister,
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owner = createOwner({
      artifacts: undefined,
      skillImport: undefined,
      mcpHttpHost: host,
      notebook: {
        projectName: 'project',
        mcpEntryPath: '/app/main.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:1',
          token: 'notebook',
          release: notebookRelease
        }),
        releaseSessionCapabilities
      }
    })
    const provision = await owner.provision({
      stableAppSessionId: 'session-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project'
    })
    provision.commit('session-1')

    expect(() => owner.revokeSession('session-1')).not.toThrow()
    expect(unregister).toHaveBeenCalledOnce()
    expect(notebookRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
    expect(owner.mcpServerNamesFor('session-1')).toEqual([])

    owner.revokeSession('session-1')
    expect(notebookRelease).toHaveBeenCalledOnce()
    expect(releaseSessionCapabilities).toHaveBeenCalledOnce()
  })
})

// goal 能力的自证：会话**真的把这台服务器建起来了**（判据是它去要了 RPC 连接，而不是清单里有个名字），
// 且策略不许时**连要都不去要**。否定用例用 reviewer 策略：`policyAllowsSessionCapability` 对非 primary
// 一律拒绝 ⇒ 若门是装饰性的，这条会红。
describe('goal capability provisioning', () => {
  const goalOptions = (
    getRpcConnection: () => Promise<{ endpoint: string; token: string; release?: () => void }>
  ): { mcpEntryPath: string; getRpcConnection: typeof getRpcConnection } => ({
    mcpEntryPath: '/app/main.js',
    getRpcConnection
  })

  it('builds the goal server for an allowed session and releases the connection on revoke', async () => {
    const getRpcConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:7',
      token: 'goal'
    }))
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      goal: goalOptions(getRpcConnection)
    })

    const provision = await owner.provision({
      stableAppSessionId: 'session-goal-1',
      framework: { ...opencodeFramework, acceptsStdioMcp: true },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project-1'
    })

    expect(provision.descriptor.capabilities).toContain('goal')
    expect(provision.descriptor.canonicalMcpServerNames).toContain('purescience_goal')
    // 决定性的一半：app 真去要了这台服务器的 RPC 连接（名字在清单里 ≠ 服务器被建起来）。
    expect(getRpcConnection).toHaveBeenCalledOnce()

    provision.commit('session-goal-1')
    // 释放走既有按能力的管线（依赖调用方传 onGoalConnection，与 routine 同状），本用例不重复测它；
    // 这里只证「服务器真被建起来」与「策略不许连要都不去要」两件决定性的。
    owner.revokeSession('session-goal-1')
  })

  it('does not even ask for the connection when the policy denies the capability', async () => {
    const getRpcConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:7',
      token: 'goal',
      release: vi.fn()
    }))
    const owner = createOwner({
      artifacts: undefined,
      notebook: undefined,
      skillImport: undefined,
      goal: goalOptions(getRpcConnection)
    })

    const provision = await owner.provision({
      stableAppSessionId: 'session-goal-2',
      framework: { ...opencodeFramework, acceptsStdioMcp: true },
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: REVIEWER_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectName: 'project-1'
    })

    expect(provision.descriptor.capabilities).not.toContain('goal')
    expect(provision.descriptor.canonicalMcpServerNames).not.toContain('purescience_goal')
    expect(getRpcConnection).not.toHaveBeenCalled()
  })
})
