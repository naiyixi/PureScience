import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaudeInstallEvent } from '../../shared/settings'
import type { ConnectorSettingsModule } from './connector-settings'
import type { ClaudeDetectDeps } from './claude-detect'
import type { CodexDetectDeps } from './codex-detect'
import type { OpencodeDetectDeps } from './opencode-detect'
import type { ProviderPreflightAccess } from './agent-runtime-manager'
import type { SkillCatalogModule } from './skill-catalog'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/no-such-app-root', isPackaged: false }
}))

const { AgentRuntimeManager } = await import('./agent-runtime-manager')
const { SettingsRepository } = await import('./repository')
const { getAppClaudeConfigDir } = await import('./provider-env')
const { managedClaudeDir } = await import('./managed-claude')
const { managedOpencodeDir } = await import('./managed-opencode')
const { initDataRoot, resolveDataRoot } = await import('../storage-root')
const { pathGuardRootsFile } = await import('./path-guard-hook')

type Repository = InstanceType<typeof SettingsRepository>
type ManagerOptions = ConstructorParameters<typeof AgentRuntimeManager>[0]

type RuntimeInventory = {
  claude: Map<string, string | undefined>
  opencode: Map<string, string | undefined>
  codexAdapter: Map<string, string | undefined>
  codexNative: Map<string, string | undefined>
}

const createInventory = (): RuntimeInventory => ({
  claude: new Map(),
  opencode: new Map(),
  codexAdapter: new Map(),
  codexNative: new Map()
})

const createClaudeDeps = (inventory: RuntimeInventory): ClaudeDetectDeps => ({
  env: {},
  homePath: '/home',
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(inventory.claude.has(path)),
  getVersion: (path) => Promise.resolve(inventory.claude.get(path)),
  resolveNpmBinDirs: () => Promise.resolve([])
})

const createOpencodeDeps = (inventory: RuntimeInventory): OpencodeDetectDeps => ({
  env: {},
  homePath: '/home',
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(inventory.opencode.has(path)),
  getVersion: (path) => Promise.resolve(inventory.opencode.get(path)),
  resolveNpmBinDirs: () => Promise.resolve([])
})

const createCodexDeps = (
  inventory: RuntimeInventory,
  managedAdapterPath: string,
  managedCodexPath: string
): CodexDetectDeps => ({
  env: {},
  homePath: '/home',
  platform: 'linux',
  isRunnable: (path) => Promise.resolve(inventory.codexAdapter.has(path)),
  getAdapterVersion: (path) => Promise.resolve(inventory.codexAdapter.get(path)),
  getCodexVersion: (path) => Promise.resolve(inventory.codexNative.get(path)),
  smokeInitialize: () => Promise.resolve(true),
  resolveNpmBinDirs: () => Promise.resolve([]),
  managedAdapterPath,
  managedCodexPath
})

describe('AgentRuntimeManager', () => {
  let storageRoot: string
  let repository: Repository
  let inventory: RuntimeInventory
  let managedAdapterPath: string
  let managedCodexPath: string
  let provisionClaudeConfig: ReturnType<typeof vi.fn>
  let materializeSkills: ReturnType<typeof vi.fn>
  // What the catalog reports as always-on. Mutable per case: the point of the gate is that it cannot be
  // bypassed per target, so a case has to be able to make a skill always-on.
  let alwaysOnIds = new Set<string>()
  let manager: InstanceType<typeof AgentRuntimeManager>

  const createManager = (
    overrides: Partial<ManagerOptions> = {}
  ): InstanceType<typeof AgentRuntimeManager> => {
    provisionClaudeConfig = vi.fn().mockResolvedValue(undefined)
    materializeSkills = vi.fn().mockResolvedValue(undefined)
    const skills = {
      materializeSkills,
      provisionClaudeConfig,
      alwaysOnSkillIds: vi.fn(async () => new Set(alwaysOnIds))
    } as unknown as SkillCatalogModule
    const connectors = {
      getConnectors: vi.fn().mockResolvedValue(undefined),
      enabledConnectorIds: vi.fn().mockReturnValue([])
    } as unknown as ConnectorSettingsModule

    return new AgentRuntimeManager({
      repository,
      storageRoot,
      userClaudeDir: join(storageRoot, 'user-claude'),
      skills,
      connectors,
      allocateSettingsIdSequence: vi.fn().mockReturnValue(1),
      detectDeps: createClaudeDeps(inventory),
      opencodeDetectDeps: createOpencodeDeps(inventory),
      codexDetectDeps: createCodexDeps(inventory, managedAdapterPath, managedCodexPath),
      allocateOpenCodeUsagePort: () => Promise.resolve(42_424),
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      installManagedOpencodeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      installManagedCodexImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      resolveCodexProxyEnvironment: () => Promise.resolve(undefined),
      ...overrides
    })
  }

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'purescience-runtime-manager-'))
    repository = new SettingsRepository(storageRoot)
    inventory = createInventory()
    managedAdapterPath = join(storageRoot, 'codex-managed', 'adapter', 'dist', 'index.js')
    managedCodexPath = join(storageRoot, 'codex-managed', 'codex', 'bin', 'codex')
    manager = createManager()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('persists successful detection for all three runtime storage shapes', async () => {
    // The injected detector platform is Linux, so keep these virtual inventory paths POSIX on every
    // host. Using the host path helpers makes the Windows keys disagree with the detector probes.
    const claudePath = posix.join('/detected', 'claude')
    const opencodePath = posix.join('/detected', 'opencode')
    inventory.claude.set(claudePath, '2.1.0')
    inventory.opencode.set(opencodePath, '1.19.0')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.1.4')
    inventory.codexNative.set(managedCodexPath, 'codex-cli 0.144.6')
    manager = createManager({
      detectDeps: { ...createClaudeDeps(inventory), env: { PATH: posix.dirname(claudePath) } },
      opencodeDetectDeps: {
        ...createOpencodeDeps(inventory),
        env: { PATH: posix.dirname(opencodePath) }
      }
    })

    await manager.detectClaude()
    await manager.detectOpencode()
    await manager.detectCodex()

    expect(await repository.getSettings()).toMatchObject({
      claude: { resolvedPath: claudePath, version: '2.1.0' },
      opencodePath,
      opencodeVersion: '1.19.0',
      codex: {
        resolvedPath: managedAdapterPath,
        version: '1.1.4',
        nativePath: managedCodexPath,
        nativeVersion: '0.144.6'
      }
    })
  })

  it('preserves cached runtime records when live detection misses but their paths still exist', async () => {
    const claudePath = join(storageRoot, 'cached', 'claude')
    const opencodePath = join(storageRoot, 'cached', 'opencode')
    await mkdir(dirname(claudePath), { recursive: true })
    for (const path of [claudePath, opencodePath, managedAdapterPath]) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '#!/bin/sh\n')
      await chmod(path, 0o755)
    }
    await repository.setClaudeInfo({ resolvedPath: claudePath, version: 'cached-claude' })
    await repository.setOpencodeInfo(opencodePath, 'cached-opencode')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: 'cached-adapter',
      nativePath: managedCodexPath,
      nativeVersion: 'cached-native'
    })

    await manager.detectClaude()
    await manager.detectOpencode()
    await manager.detectCodex()

    expect(await repository.getSettings()).toMatchObject({
      claude: { resolvedPath: claudePath, version: 'cached-claude' },
      opencodePath,
      opencodeVersion: 'cached-opencode',
      codex: { resolvedPath: managedAdapterPath, version: 'cached-adapter' }
    })
  })

  it('computes selected-runtime preflight through the narrow provider access interface', async () => {
    const opencodePath = join(storageRoot, 'bin', 'opencode')
    inventory.opencode.set(opencodePath, '1.19.0')
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    await repository.setAgentFramework('opencode')
    await repository.upsertProvider({
      id: 'provider-a',
      type: 'custom',
      name: 'Provider A',
      model: 'model-a',
      apiEndpoints: ['openai'],
      keyRef: 'encrypted-key',
      lastValidatedAt: 10
    })
    await repository.setActiveProvider('provider-a', 'model-a')
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(['openai']),
      resolveActiveModel: vi.fn().mockReturnValue('model-a'),
      isProviderKeyUsable: vi.fn().mockResolvedValue(true)
    }

    const result = await manager.getPreflight(providers)
    const storedProvider = (await repository.getSettings()).providers[0]

    expect(result).toMatchObject({
      agentFrameworkId: 'opencode',
      opencodeReady: true,
      activeProviderReady: true,
      agentReady: true
    })
    expect(providers.resolveProviderApiEndpoints).toHaveBeenCalledWith(storedProvider, 'model-a')
    expect(providers.isProviderKeyUsable).toHaveBeenCalledWith(storedProvider)
  })

  it('runs the binary probes together instead of one after another', async () => {
    const claudePath = join(storageRoot, 'bin', 'claude')
    const opencodePath = join(storageRoot, 'bin', 'opencode')
    await repository.setClaudeInfo({ resolvedPath: claudePath, version: '2.1.0' })
    await repository.setOpencodeInfo(opencodePath, '1.19.0')

    const started: string[] = []
    let releaseGate: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const gatedProbe = (name: string, version: string): ((path: string) => Promise<string>) =>
      vi.fn(async () => {
        started.push(name)
        await gate
        return version
      })

    manager = createManager({
      detectDeps: { ...createClaudeDeps(inventory), getVersion: gatedProbe('claude', '2.1.0') },
      opencodeDetectDeps: {
        ...createOpencodeDeps(inventory),
        getVersion: gatedProbe('opencode', '1.19.0')
      }
    })
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(['anthropic']),
      resolveActiveModel: vi.fn().mockReturnValue('model-a'),
      isProviderKeyUsable: vi.fn().mockResolvedValue(true)
    }

    const pending = manager.getPreflight(providers)
    // A sequential implementation would still be sitting inside the first probe here, with the second
    // one never started.
    await vi.waitFor(() => expect(started).toHaveLength(2))
    releaseGate()

    await expect(pending).resolves.toMatchObject({ claudeReady: true, opencodeReady: true })
  })

  it('names the slow probe and logs one summary, while a fast preflight stays silent', async () => {
    const claudePath = join(storageRoot, 'bin', 'claude')
    const opencodePath = join(storageRoot, 'bin', 'opencode')
    await repository.setClaudeInfo({ resolvedPath: claudePath, version: '2.1.0' })
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(['anthropic']),
      resolveActiveModel: vi.fn().mockReturnValue('model-a'),
      isProviderKeyUsable: vi.fn().mockResolvedValue(true)
    }

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    manager = createManager({
      preflightLog: log,
      preflightSlowMs: 50,
      opencodeDetectDeps: {
        ...createOpencodeDeps(inventory),
        getVersion: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150))
          return '1.19.0'
        }
      }
    })

    await manager.getPreflight(providers)

    // Only the probe that actually took the time is named; a slow read or a slow key check would show
    // up as its own step instead of being blamed on a probe.
    const slowProbes = log.warn.mock.calls
      .filter(([, fields]) => String((fields as Record<string, unknown>).step).startsWith('probe-'))
      .map(([, fields]) => (fields as Record<string, unknown>).step)
    expect(slowProbes).toEqual(['probe-opencode'])
    expect(log.warn.mock.calls[0][0]).toBe('preflight step slow')
    expect(log.info).toHaveBeenCalledOnce()
    const [summaryMessage, summaryFields] = log.info.mock.calls[0] as [
      string,
      Record<string, unknown>
    ]
    expect(summaryMessage).toBe('preflight steps')
    expect(String(summaryFields.slowest)).toContain('probe-opencode=')

    const quietLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    // A frozen clock, because the claim is about the plumbing — "a preflight with no slow step logs nothing" —
    // and a real clock turns it into a claim about this machine's load. On a busy machine a settings read took
    // 73 ms and the case went red with nothing in the code to fix. The slow half above still runs on the real
    // clock, so the timing path itself remains covered.
    manager = createManager({ preflightLog: quietLog, preflightSlowMs: 50, preflightNow: () => 0 })
    await manager.getPreflight(providers)

    expect(quietLog.warn).not.toHaveBeenCalled()
    expect(quietLog.info).not.toHaveBeenCalled()
  })

  it('names every phase of an environment check and logs one summary; a fast one stays silent', async () => {
    // A clock that advances 100 ms per read makes every phase deterministically slow, so the assertion is
    // about the plumbing (which phases are timed) rather than about this machine's speed.
    let tick = 0
    const advancing = (): number => (tick += 100)
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const checkDeps = {
      platform: 'darwin' as const,
      architecture: 'arm64',
      verifyStorage: async (): Promise<void> => undefined,
      resolveManagedPlatform: () => ({ key: 'darwin-arm64' }),
      findPython: async () => ({ command: 'python3', baseArgs: [] as string[] }),
      probeRegistry: async () => 20
    }
    manager = createManager({
      preflightNow: advancing,
      environmentCheckLog: log,
      environmentCheckSlowMs: 50,
      environmentCheckDeps: checkDeps
    })

    const result = await manager.checkEnvironment()

    // The answer still exists and still carries the rows the window renders.
    expect(result.checks.map((check) => check.id)).toContain('install-network')
    // Every phase is named exactly once, spanning both halves: the four detections this manager runs and
    // the four phases environment-check owns. Compared as a sorted set: the phases run concurrently, so
    // the order the slow lines appear in is completion order and carries no meaning.
    const named = log.warn.mock.calls
      .map(([, fields]) => String((fields as Record<string, unknown>).step))
      .sort()
    expect(named).toEqual(
      [
        'detect-claude',
        'detect-codebuddy',
        'detect-codex',
        'detect-opencode',
        'find-python',
        'probe-npmmirror',
        'probe-npmjs',
        'settings-read',
        'verify-storage'
      ].sort()
    )
    expect(
      log.warn.mock.calls.every(([message]) => message === 'environment check step slow')
    ).toBe(true)
    // One summary per call — a healthy call stays silent instead of logging per phase.
    expect(log.info).toHaveBeenCalledOnce()
    const [summaryMessage, summaryFields] = log.info.mock.calls[0] as [
      string,
      Record<string, unknown>
    ]
    expect(summaryMessage).toBe('environment check steps')
    expect(summaryFields.stepCount).toBe(9)

    const quietLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    let frozen = 0
    manager = createManager({
      preflightNow: () => frozen++,
      environmentCheckLog: quietLog,
      environmentCheckSlowMs: 50,
      environmentCheckDeps: checkDeps
    })

    await manager.checkEnvironment()

    expect(quietLog.warn).not.toHaveBeenCalled()
    expect(quietLog.info).not.toHaveBeenCalled()
  })

  it('uses the shared allocator and forwards the same event sink through managed installs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    const allocateSettingsIdSequence = vi
      .fn<() => number>()
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(13)
    const onEvent = vi.fn<(event: ClaudeInstallEvent) => void>()
    const installManagedClaudeImpl: NonNullable<ManagerOptions['installManagedClaudeImpl']> = vi.fn(
      async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'claude\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          resolvedPath: join(storageRoot, 'installed', 'claude'),
          version: '2.1.0'
        }
      }
    )
    const installManagedOpencodeImpl: NonNullable<ManagerOptions['installManagedOpencodeImpl']> =
      vi.fn(async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'opencode\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          resolvedPath: join(storageRoot, 'installed', 'opencode'),
          version: '1.19.0'
        }
      })
    const installManagedCodexImpl: NonNullable<ManagerOptions['installManagedCodexImpl']> = vi.fn(
      async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'codex\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          adapterPath: managedAdapterPath,
          adapterVersion: '1.1.4',
          codexPath: managedCodexPath,
          codexVersion: '0.144.6'
        }
      }
    )
    const claudePath = join(storageRoot, 'installed', 'claude')
    inventory.claude.set(claudePath, '2.1.0')
    manager = createManager({
      allocateSettingsIdSequence,
      installManagedClaudeImpl,
      installManagedOpencodeImpl,
      installManagedCodexImpl
    })

    const results = await Promise.all([
      manager.installClaude({ source: 'managed' }, onEvent),
      manager.installOpencode({ source: 'managed' }, onEvent),
      manager.installCodex({ source: 'managed' }, onEvent)
    ])

    expect(results.map((result) => result.installId)).toEqual([
      'install-123-11',
      'install-opencode-123-12',
      'install-codex-123-13'
    ])
    expect(allocateSettingsIdSequence).toHaveBeenCalledTimes(3)
    for (const installer of [
      installManagedClaudeImpl,
      installManagedOpencodeImpl,
      installManagedCodexImpl
    ]) {
      expect(installer).toHaveBeenCalledWith(expect.objectContaining({ onEvent }))
    }
    expect(onEvent.mock.calls.map(([event]) => event.installId)).toEqual([
      'install-123-11',
      'install-opencode-123-12',
      'install-codex-123-13'
    ])
  })

  it('fails a managed Claude install whose installed executable cannot report a version', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(321)
    const installedPath = join(storageRoot, 'installed', 'claude')
    const onEvent = vi.fn<(event: ClaudeInstallEvent) => void>()
    manager = createManager({
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: true },
        resolvedPath: installedPath,
        version: 'claimed-version'
      })
    })

    const result = await manager.installClaude({ source: 'managed' }, onEvent)

    expect(result).toEqual({
      installId: 'install-321-1',
      ok: false,
      error:
        'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.'
    })
    expect((await repository.getSettings()).claude).toBeUndefined()
    expect(onEvent).toHaveBeenCalledWith({
      kind: 'log',
      installId: 'install-321-1',
      stream: 'system',
      chunk:
        'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.\n'
    })
  })

  it('guards unmanaged uninstall and selects the first actually runnable fallback', async () => {
    const unmanagedClaude = join(storageRoot, 'external', 'claude')
    await repository.setClaudeInfo({ resolvedPath: unmanagedClaude, version: '2.1.0' })

    await expect(manager.uninstallClaude()).resolves.toEqual({ activeBackendAffected: false })
    expect((await repository.getSettings()).claude?.resolvedPath).toBe(unmanagedClaude)

    const opencodePath = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(dirname(opencodePath), { recursive: true })
    await writeFile(opencodePath, '#!/bin/sh\n')
    await chmod(opencodePath, 0o755)
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: '1.1.4',
      nativePath: managedCodexPath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('opencode')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.1.4')
    // The stored Claude path exists as a candidate but cannot report a version, so it is not ready.
    inventory.claude.set(unmanagedClaude, undefined)

    await expect(manager.uninstallOpencode()).resolves.toEqual({ activeBackendAffected: true })

    expect(await repository.getSettings()).toMatchObject({
      agentFrameworkId: 'codex',
      claude: { resolvedPath: unmanagedClaude },
      codex: { resolvedPath: managedAdapterPath }
    })
    expect((await repository.getSettings()).opencodePath).toBeUndefined()
  })

  it('provisions the runtime and preserves the shared versus isolated Claude probe contracts', async () => {
    const executeClaudeProbe = vi.fn().mockResolvedValue(undefined)
    manager = createManager({ executeClaudeProbe })
    const executablePath = join(storageRoot, 'bin', 'claude')
    await repository.setClaudeInfo({ resolvedPath: executablePath, version: '2.1.0' })
    const settings = await repository.getSettings()

    await expect(
      manager.runClaudeSubscriptionProbe(
        { type: 'claude-shared', model: 'claude-sonnet' },
        settings
      )
    ).resolves.toEqual({ ok: true, category: 'ok' })
    await expect(
      manager.runClaudeSubscriptionProbe(
        { type: 'claude-isolated', model: 'claude-sonnet', key: 'setup-token' },
        settings
      )
    ).resolves.toEqual({ ok: true, category: 'ok' })

    const configDir = getAppClaudeConfigDir(storageRoot)
    expect(provisionClaudeConfig).toHaveBeenCalledTimes(2)
    expect(executeClaudeProbe).toHaveBeenNthCalledWith(
      1,
      executablePath,
      expect.objectContaining({ CLAUDE_CONFIG_DIR: join(storageRoot, 'user-claude') }),
      ['--settings', join(configDir, 'settings.json'), '--plugin-dir', configDir]
    )
    expect(executeClaudeProbe).toHaveBeenNthCalledWith(
      2,
      executablePath,
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_OAUTH_TOKEN: 'setup-token'
      })
    )
  })

  // P0-11. The fence's root list is app-owned resolution, and "data root" is a different concept from
  // "config root" — an install may keep them in different folders (the dev layout here does).
  it('fences the agent to the storage layer data root, never to the config root in its place', async () => {
    manager = createManager()
    const settings = await repository.getSettings()

    await manager.provisionClaudeRuntimeConfig(settings)

    // The regression this pins: with no picked data root, the old expression fell back to the CONFIG root,
    // so the fence named the folder that holds settings/skills/DB and named nothing that holds projects,
    // workspaces or notebook data. The guard then refused the agent's own session workspace.
    const dataRoot = resolveDataRoot()
    expect(dataRoot).not.toBe(storageRoot)
    expect(provisionClaudeConfig.mock.calls.at(-1)?.[5]).toEqual({
      roots: [dataRoot, storageRoot],
      hint: dataRoot
    })
    // Stated as the user-visible consequence, not just as an array shape: the folder the app writes
    // sessions and notebook outputs into is fenced, and the config root stays fenced too.
    const roots = (provisionClaudeConfig.mock.calls.at(-1)?.[5] as { roots: string[] }).roots
    expect(roots).toContain(dataRoot)
    expect(roots).toContain(storageRoot)
  })

  it('fences to a data root the user picked, alongside the config root', async () => {
    const picked = join(storageRoot, 'picked-data-root')
    initDataRoot(picked)
    try {
      manager = createManager()
      const settings = await repository.getSettings()

      await manager.provisionClaudeRuntimeConfig(settings)

      expect(provisionClaudeConfig.mock.calls.at(-1)?.[5]).toEqual({
        roots: [picked, storageRoot],
        hint: picked
      })
    } finally {
      // The data root is cached module state (a change needs a restart), so restore the default for the
      // rest of the file rather than leaking this case's root into every later provisioning pass.
      initDataRoot(undefined)
    }
  })

  it('writes the same fence file when both roots resolve to one folder', () => {
    // The legacy/packaged layout resolves both concepts to the same folder (no separate PureScience data
    // dir). The dedupe is what keeps this fix a no-op there: same roots, same hint, same bytes as before.
    const same = join(storageRoot, 'legacy-root')
    expect(pathGuardRootsFile([same, same], same)).toBe(pathGuardRootsFile([same], same))
  })

  it('synchronizes the Compute host projection after each Skill provisioning path', async () => {
    const syncComputeSkillDocument = vi.fn().mockResolvedValue(undefined)
    manager = createManager({ syncComputeSkillDocument })
    const settings = await repository.getSettings()
    const agentRoot = join(storageRoot, 'codex')

    await manager.materializeAgentSkills(settings, agentRoot, new Set(), 'codex')
    await manager.provisionClaudeRuntimeConfig(settings)

    expect(syncComputeSkillDocument).toHaveBeenCalledWith(join(agentRoot, 'skills'))
    expect(syncComputeSkillDocument).toHaveBeenCalledWith(
      join(getAppClaudeConfigDir(storageRoot), 'skills')
    )
  })

  it('withholds a skill from the target that asked, and only that target', async () => {
    manager = createManager()
    const settings = {
      ...(await repository.getSettings()),
      skillAvailability: { codex: { disabledSkillIds: ['pdf-notes'] } }
    }
    const agentRoot = join(storageRoot, 'codex')

    await manager.materializeAgentSkills(settings, agentRoot, new Set(), 'codex')
    expect(materializeSkills.mock.calls.at(-1)?.[1]).toContain('pdf-notes')

    await manager.materializeAgentSkills(settings, agentRoot, new Set(), 'claude-code')
    // The other target must be untouched: a per-target set that leaked everywhere would be a global switch
    // wearing a matrix.
    expect(materializeSkills.mock.calls.at(-1)?.[1]).not.toContain('pdf-notes')

    await manager.provisionClaudeRuntimeConfig(settings)
    expect(provisionClaudeConfig.mock.calls.at(-1)?.[1]).not.toContain('pdf-notes')

    // And the row that DID ask for it reaches the Claude provisioning — otherwise the matrix would be a
    // label on this path while the codex path honoured it.
    const claudeSettings = {
      ...(await repository.getSettings()),
      skillAvailability: { 'claude-code': { disabledSkillIds: ['pdf-notes'] } }
    }
    await manager.provisionClaudeRuntimeConfig(claudeSettings)
    expect(provisionClaudeConfig.mock.calls.at(-1)?.[1]).toContain('pdf-notes')
  })

  it('cannot be used to turn off an always-on gatekeeper skill', async () => {
    alwaysOnIds = new Set(['os-gatekeeper'])
    manager = createManager()
    const settings = {
      ...(await repository.getSettings()),
      disabledSkillIds: ['os-gatekeeper'],
      skillAvailability: { codex: { disabledSkillIds: ['os-gatekeeper', 'pdf-notes'] } }
    }

    await manager.materializeAgentSkills(settings, join(storageRoot, 'codex'), new Set(), 'codex')

    const passed = materializeSkills.mock.calls.at(-1)?.[1] as string[]
    expect(passed).toContain('pdf-notes')
    // A per-target set that could hold it would be a documented way around the gate.
    expect(passed).not.toContain('os-gatekeeper')
  })

  it.each([
    {
      name: 'timeout',
      error: Object.assign(new Error('timed out'), { killed: true }),
      result: {
        ok: false,
        category: 'timeout',
        message: 'Claude token validation timed out. Try again.'
      }
    },
    {
      name: 'authentication rejection',
      error: Object.assign(new Error('request failed'), { stderr: 'HTTP 401 unauthorized' }),
      result: {
        ok: false,
        category: 'auth',
        message:
          'Claude rejected the setup token. Run `claude setup-token` again and paste a new token.'
      }
    },
    {
      name: 'network failure',
      error: Object.assign(new Error('fetch failed'), { code: 'ENETUNREACH' }),
      result: {
        ok: false,
        category: 'network',
        message:
          'Claude could not reach Anthropic while validating the token. Check your network and try again.'
      }
    }
  ])(
    'classifies an isolated Claude $name without mutating provider state',
    async ({ error, result }) => {
      manager = createManager({ executeClaudeProbe: vi.fn().mockRejectedValue(error) })
      await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })

      await expect(
        manager.runClaudeSubscriptionProbe(
          { type: 'claude-isolated', key: 'setup-token' },
          await repository.getSettings()
        )
      ).resolves.toEqual(result)
      expect((await repository.getSettings()).providers).toEqual([])
    }
  )

  it('uses the managed Claude directory shape expected by the uninstall ownership guard', () => {
    expect(
      manager.isManagedRuntimePath('claude-code', join(managedClaudeDir(storageRoot), 'claude'))
    ).toBe(true)
    expect(
      manager.isManagedRuntimePath('claude-code', join(storageRoot, 'external', 'claude'))
    ).toBe(false)
  })

  it('owns materialization of framework-generated runtime config files', async () => {
    const configPath = join(storageRoot, 'runtime-config', 'agent.json')

    await manager.materializeAgentConfigFiles([
      { path: configPath, content: '{"runtime":"managed"}\n' }
    ])

    await expect(readFile(configPath, 'utf8')).resolves.toBe('{"runtime":"managed"}\n')
  })
})
