import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { ApplicationEventChannel } from '../main/application-events'
import { REMOTE_LOCAL_ONLY_RPC_CHANNELS } from '../main/web-service/http-server'
import { RENDERER_CONTRACT_CATALOG } from './renderer-contract-catalog'
import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'
import { WEB_RPC_ALLOWED_CHANNELS, WEB_RPC_UNAVAILABLE_CHANNELS } from './web-rpc-contract'

const { exposeMock } = vi.hoisted(() => ({ exposeMock: vi.fn() }))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeMock },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn()
  },
  net: { fetch: vi.fn() },
  webUtils: { getPathForFile: vi.fn() }
}))

type GroupedInventory = Readonly<Record<string, readonly string[]>>

const expand = (groups: GroupedInventory, separator: string): string[] =>
  Object.entries(groups).flatMap(([prefix, names]) =>
    names.map((name) => (prefix ? `${prefix}${separator}${name}` : name))
  )

const expectSameSet = (actual: Iterable<string>, expected: Iterable<string>): void => {
  const actualValues = [...actual]
  const expectedValues = [...expected]

  expect(new Set(actualValues).size).toBe(actualValues.length)
  expect(new Set(expectedValues).size).toBe(expectedValues.length)
  expect(actualValues.sort()).toEqual(expectedValues.sort())
}

type InstalledWebEventChannel = (typeof WEB_EVENT_CHANNELS)[keyof typeof WEB_EVENT_CHANNELS]
type InstalledButNotDeliveredEventChannel = Exclude<
  InstalledWebEventChannel,
  ApplicationEventChannel
>

const INSTALLED_BUT_NOT_DELIVERED_EVENTS = {
  'notebook-env:progress': true,
  'notifications:open-session': true,
  'notifications:probe-unread-view': true,
  'shortcut:close-active-pane': true,
  'uploads:transfer-progress': true
} as const satisfies Record<InstalledButNotDeliveredEventChannel, true>

// These functions exist on the real Electron preload API but the current AST generator does not
// recognize their implementation shape or channel constants. T1b must make each omission explicit.
const GENERATED_SOURCE_OMISSIONS = [
  'clipboard.writeText',
  'diagnostics.exportSupportBundle',
  'diagnostics.reportRendererFailure',
  'getRuntimeVersions',
  'handoff.list',
  'handoff.onChanged',
  'handoff.retry',
  'network.checkConnectivity',
  'network.getInfo',
  'notifications.getSnapshot',
  'notifications.markAllRead',
  'notifications.markRead',
  'notifications.markSessionCompletionsRead',
  'notifications.onChanged',
  'notifications.syncViewState',
  'officePreview.attachFrame',
  'officePreview.close',
  'officePreview.onState',
  'officePreview.open',
  'officePreview.reportState',
  'roCrate.exportProject',
  'sessions.exportPackage',
  'sessions.importPackage',
  'sessions.onFlushRequest',
  'sessions.previewPackage',
  'sessions.sendFlushResponse',
  'settings.exportCustomServerTemplate',
  'settings.exportSkill',
  'settings.previewCustomServerTemplateExport',
  'settings.selectCustomServerTemplate',
  'specialist.cancelHandoff',
  'specialist.cancelPackage',
  'specialist.create',
  'specialist.delete',
  'specialist.duplicate',
  'specialist.exportContributionTemplate',
  'specialist.exportSpecialist',
  'specialist.getHandoffEvents',
  'specialist.installPackage',
  'specialist.list',
  'specialist.onCatalogChanged',
  'specialist.onHandoffLifecycleEvent',
  'specialist.onPendingSwitch',
  'specialist.previewDelete',
  'specialist.previewExport',
  'specialist.resolveSessionSpecialist',
  'specialist.retryHandoff',
  'specialist.savePackageReport',
  'specialist.selectPackage',
  'specialist.setEnabled',
  'specialist.setSessionSpecialist',
  'specialist.update',
  'specialist.marketplaceAddSource',
  'specialist.marketplaceCancelCandidate',
  'specialist.marketplaceGetRelease',
  'specialist.marketplaceInspectGithubSource',
  'specialist.marketplaceInstall',
  'specialist.marketplaceList',
  'specialist.marketplacePrepareInstall',
  'specialist.marketplaceRemoveSource',
  'specialist.onMarketplaceDownloadProgress',
  'window.announceWindowFindAppearance',
  'window.announceWindowFindReady',
  'window.clearFind',
  'window.closeFind',
  'window.findInPage',
  'window.onCloseConfirmRequest',
  'window.onFindInPageResult',
  'window.onShowWindowFind',
  'window.onWindowFindAppearance',
  'window.sendCloseConfirmResponse'
] as const

const BROWSER_NATIVE_CALLABLE_PATHS = [
  'getRuntimeVersions',
  'saveBlobFile',
  'saveManagedFile',
  'window.close'
] as const

const WEB_UNAVAILABLE_CHANNELS = [
  'file:save-blob',
  'file:save-managed',
  'file:save-session-artifacts',
  'sessions:export-conversation',
  'settings:import-agent-home-skills',
  'settings:list-agent-home-skills',
  'uploads:stage-local-file',
  'window:close'
] as const

const REMOTE_LOCAL_ONLY_CHANNELS: GroupedInventory = {
  artifacts: ['open-file', 'reveal-file', 'write-user-edited-version'],
  cli: ['install', 'uninstall'],
  compute: ['download', 'reveal-in-folder'],
  'local-fs': ['get-roots', 'list-dir', 'open-path', 'read-preview', 'reveal'],
  logs: ['open-file', 'reveal-in-folder'],
  'notebook-env': ['cancel', 'provision', 'repair'],
  notebook: ['export-ipynb', 'export-ipynb-all'],
  routine: ['list-all', 'remove', 'set-enabled', 'upsert'],
  endpoint: ['approve', 'list-all', 'register', 'remove', 'start', 'stop'],
  bookmark: ['list', 'remove', 'set', 'update-note'],
  'search-pins': ['list', 'remove', 'save'],
  annotation: ['list', 'remove', 'set'],
  pdf: ['figures', 'open', 'outline', 'pages', 'scan', 'tables'],
  'pdf-annotations': [
    'create',
    'export-annotated',
    'export-notes',
    'import',
    'list',
    'reattach',
    'remove'
  ],
  figure: ['review'],
  query: ['run'],
  search: ['query', 'evidence'],
  runtime: [
    'import-lock',
    'manage-named-environments',
    'pick-interpreter',
    'register-interpreter',
    'set-environment-enabled',
    'set-install-authorized',
    'set-selection',
    'unregister-interpreter'
  ],
  settings: [
    'authenticate-custom-server',
    'cancel-claude-login',
    'cancel-codex-login',
    'cancel-custom-server-authentication',
    'cancel-isolated-claude-login',
    'function-models',
    'skill-availability',
    'install-claude',
    'install-codebuddy',
    'install-codex',
    'install-opencode',
    'login-isolated-claude',
    'login-isolated-claude-browser',
    'login-isolated-codex',
    'login-shared-claude',
    'logout-isolated-claude',
    'logout-isolated-codex',
    'logout-shared-claude',
    'set-app-icon-variant',
    'set-close-preference',
    'set-ui-language',
    'set-default-permission-profile',
    'get-memory',
    'list-credentials',
    'get-egress',
    'set-egress',
    'get-proxy',
    'set-proxy',
    'execution-protection',
    'list-external-compute-endpoints',
    'set-external-compute-endpoint',
    'delete-external-compute-endpoint',
    'get-auto-apply',
    'set-auto-apply',
    'set-credential',
    'delete-credential',
    'test-credential',
    'set-memory',
    'set-notifications-enabled',
    'set-package-mirror',
    'set-use-intent',
    'third-party-licenses',
    'uninstall-claude',
    'uninstall-codex',
    'uninstall-opencode'
  ],
  storage: [
    'cancel-migrate',
    'commit-and-relaunch',
    'discard-migrated-copy',
    'inspect-data-root',
    'migrate',
    'pick-directory',
    'reveal-app-storage',
    'set-data-root-and-relaunch',
    'validate-data-root'
  ],
  update: ['apply', 'cancel', 'download'],
  uploads: ['stage-local-path']
}

const ELECTRON_ONLY_CALLABLE_PATHS = [
  ...GENERATED_SOURCE_OMISSIONS.filter((path) => path !== 'getRuntimeVersions'),
  'saveSessionArtifacts',
  'sessions.exportConversation',
  'settings.importAgentHomeSkills',
  'settings.listAgentHomeSkills',
  'uploads.stageLocalFile'
] as const

const collectFunctionPaths = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'function') return [prefix]
  if (!value || typeof value !== 'object') return []

  return Object.entries(value).flatMap(([key, child]) =>
    collectFunctionPaths(child, prefix ? `${prefix}.${key}` : key)
  )
}

let exposedApi: unknown

beforeAll(async () => {
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await import('../preload/index')
  exposedApi = exposeMock.mock.calls.find(([name]) => name === 'api')?.[1]
  if (!exposedApi) throw new Error('preload did not expose window.api')
})

describe('renderer surface inventory', () => {
  it('pins the cross-surface inventory and every generator omission', () => {
    const electronPaths = collectFunctionPaths(exposedApi)
    const generatedPaths = new Set([
      ...Object.keys(WEB_INVOKE_CHANNELS),
      ...Object.keys(WEB_EVENT_CHANNELS)
    ])

    // 452 with the skill availability channel (settings:skillAvailability): a local-only settings channel
    // still exposes one preload method, so the preload inventory moves with it.
    // 451 with the function-model channel (settings.functionModels), 450 with the execution-protection
    // channel: both local-only for the same reason.
    // 449 with the RO-Crate export (roCrate.exportProject): a desktop-only channel, so it appears in the
    // preload inventory and in the generator-omission list, and in neither Web map.
    // 448 with the two PDF annotation export channels (文档标注层 A4): the preload bridge exposes one
    // method per contract, so the two inventories move together.
    // 453 with the journal metric import (references.importJournalMetrics): the bridge exposes one method per
    // contract, so the preload inventory and the catalog move together.
    // 456 with the external-lock import (runtime.importLock, A7): one local-only runtime channel, so the
    // preload inventory, the catalog and the local-Web installation count all move by one.
    // 457 with the named-environment surface (runtime.manageNamedEnvironments, audit P0-8): same profile.
    // 458 with the artifact reveal handoff (artifacts:reveal-file, IC9): one more LOCAL artifact channel,
    // so the preload inventory, the catalog and the local-Web installation count all move by one.
    expect(electronPaths).toHaveLength(458)
    expectSameSet(
      electronPaths,
      RENDERER_CONTRACT_CATALOG.map(({ publicPath }) => publicPath)
    )
    // 344 since the PDF annotation export channels (文档标注层 A4), 342 since the annotation surface
    // (A3) and 337 since the literature-screening surface (v1.77 unit): all of them are local invoke
    // channels, so the invoke map moves with them.
    expect(Object.keys(WEB_INVOKE_CHANNELS)).toHaveLength(353)
    expect(Object.keys(WEB_EVENT_CHANNELS)).toHaveLength(34)
    expectSameSet(
      electronPaths.filter((path) => !generatedPaths.has(path)),
      GENERATED_SOURCE_OMISSIONS
    )
  })

  it('pins subscriptions installed in Web but not published through ApplicationEventHub', () => {
    expectSameSet(Object.keys(INSTALLED_BUT_NOT_DELIVERED_EVENTS), [
      'notebook-env:progress',
      'notifications:open-session',
      'notifications:probe-unread-view',
      'shortcut:close-active-pane',
      'uploads:transfer-progress'
    ])
  })

  it('pins browser-native replacements and Electron-only categories', () => {
    expectSameSet(WEB_RPC_UNAVAILABLE_CHANNELS, WEB_UNAVAILABLE_CHANNELS)

    const electronPaths = new Set(collectFunctionPaths(exposedApi))
    const browserNativePaths = new Set<string>(BROWSER_NATIVE_CALLABLE_PATHS)
    const electronOnlyPaths = new Set<string>(ELECTRON_ONLY_CALLABLE_PATHS)

    expect(browserNativePaths.size).toBe(BROWSER_NATIVE_CALLABLE_PATHS.length)
    expect(electronOnlyPaths.size).toBe(ELECTRON_ONLY_CALLABLE_PATHS.length)
    expect([...browserNativePaths].every((path) => electronPaths.has(path))).toBe(true)
    expect([...electronOnlyPaths].every((path) => electronPaths.has(path))).toBe(true)
    expect([...browserNativePaths].every((path) => !electronOnlyPaths.has(path))).toBe(true)
  })

  it('pins remote local-only policy as an exact subset of local Web RPC', () => {
    const expectedRemoteLocalOnly = expand(REMOTE_LOCAL_ONLY_CHANNELS, ':')

    expectSameSet(REMOTE_LOCAL_ONLY_RPC_CHANNELS, expectedRemoteLocalOnly)
    expect(expectedRemoteLocalOnly).toHaveLength(122)
    expect(
      expectedRemoteLocalOnly.every((channel) => WEB_RPC_ALLOWED_CHANNELS.includes(channel))
    ).toBe(true)
  })
})
