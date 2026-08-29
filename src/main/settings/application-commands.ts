import type {
  AppIconPreview,
  ClaudeInstallEvent,
  InstallClaudeRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  PreviewAgentHomeSkillRequest,
  PreviewGitHubSkillRequest,
  PreviewSkillZipRequest,
  RefreshProviderModelsRequest,
  ScanRepoRequest,
  SetAppIconVariantRequest,
  SetClosePreferenceRequest,
  SetDefaultPermissionProfileRequest,
  SetNotificationsEnabledRequest,
  SetPackageMirrorRequest,
  MemorySettings,
  SetCredentialRequest,
  TestCredentialRequest,
  EgressSettings,
  CreateExternalComputeEndpointRequest,
  ValidateProviderRequest
} from '../../shared/settings'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { CallerContext } from '../caller-context'
import type { SettingsService } from './service'
import {
  readAppIconVariant,
  readClosePreference,
  readDefaultPermissionProfile,
  readNotificationsEnabled
} from './transport-validation'
import type { AppearanceSettingsWorkflows } from './workflows/appearance'

type CoreSettingsCommandStore = Pick<
  SettingsService,
  | 'cancelClaudeLogin'
  | 'cancelCodexLogin'
  | 'cancelClaudeIsolatedLogin'
  | 'checkEnvironment'
  | 'detectClaude'
  | 'detectCodex'
  | 'detectOpencode'
  | 'getConnectorDetail'
  | 'getMemory'
  | 'listCredentials'
  | 'getEgress'
  | 'listExternalComputeEndpoints'
  | 'getPackageMirror'
  | 'getPreflight'
  | 'getSettingsView'
  | 'getSkillDetail'
  | 'installClaude'
  | 'installCodex'
  | 'installOpencode'
  | 'isEncryptionAvailable'
  | 'isNpmAvailable'
  | 'listConnectors'
  | 'listSkills'
  | 'markOnboardingComplete'
  | 'previewAgentHomeSkill'
  | 'previewGitHubSkill'
  | 'previewSkillZip'
  | 'refreshProviderModels'
  | 'scanRepoSkills'
  | 'setClosePreference'
  | 'setCredential'
  | 'setDefaultPermissionProfile'
  | 'setNotificationsEnabled'
  | 'setMemory'
  | 'setPackageMirror'
  | 'deleteCredential'
  | 'testCredential'
  | 'setEgress'
  | 'setExternalComputeEndpoint'
  | 'deleteExternalComputeEndpoint'
  | 'validateProvider'
  | 'startXaiSignIn'
  | 'completeXaiSignIn'
  | 'refreshXaiOauth'
  | 'xaiOauthStatus'
  | 'logoutXai'
  | 'exportMcpServers'
  | 'importMcpServers'
>

type StoreResult<Method extends keyof CoreSettingsCommandStore> =
  CoreSettingsCommandStore[Method] extends (...args: infer _Args) => infer Result
    ? Awaited<Result>
    : never
type AppearanceResult = Awaited<ReturnType<AppearanceSettingsWorkflows['setAppIconVariant']>>

const settingsCoreApplicationCommands = Object.freeze({
  cancelClaudeLogin: defineApplicationCommand<
    'settings:cancel-claude-login',
    readonly [],
    StoreResult<'cancelClaudeLogin'>
  >('settings:cancel-claude-login'),
  cancelCodexLogin: defineApplicationCommand<
    'settings:cancel-codex-login',
    readonly [],
    StoreResult<'cancelCodexLogin'>
  >('settings:cancel-codex-login'),
  cancelIsolatedClaudeLogin: defineApplicationCommand<
    'settings:cancel-isolated-claude-login',
    readonly [],
    StoreResult<'cancelClaudeIsolatedLogin'>
  >('settings:cancel-isolated-claude-login'),
  checkEnvironment: defineApplicationCommand<
    'settings:check-environment',
    readonly [],
    StoreResult<'checkEnvironment'>
  >('settings:check-environment'),
  detectClaude: defineApplicationCommand<
    'settings:detect-claude',
    readonly [],
    StoreResult<'detectClaude'>
  >('settings:detect-claude'),
  detectCodex: defineApplicationCommand<
    'settings:detect-codex',
    readonly [],
    StoreResult<'detectCodex'>
  >('settings:detect-codex'),
  detectOpencode: defineApplicationCommand<
    'settings:detect-opencode',
    readonly [],
    StoreResult<'detectOpencode'>
  >('settings:detect-opencode'),
  getConnectorDetail: defineApplicationCommand<
    'settings:get-connector-detail',
    readonly [id: string],
    StoreResult<'getConnectorDetail'>
  >('settings:get-connector-detail'),
  getMemory: defineApplicationCommand<'settings:get-memory', readonly [], StoreResult<'getMemory'>>(
    'settings:get-memory'
  ),
  getCredentials: defineApplicationCommand<
    'settings:list-credentials',
    readonly [],
    StoreResult<'listCredentials'>
  >('settings:list-credentials'),
  getEgress: defineApplicationCommand<'settings:get-egress', readonly [], StoreResult<'getEgress'>>(
    'settings:get-egress'
  ),
  getExternalComputeEndpoints: defineApplicationCommand<
    'settings:list-external-compute-endpoints',
    readonly [],
    StoreResult<'listExternalComputeEndpoints'>
  >('settings:list-external-compute-endpoints'),
  getPackageMirror: defineApplicationCommand<
    'settings:get-package-mirror',
    readonly [],
    StoreResult<'getPackageMirror'>
  >('settings:get-package-mirror'),
  getPreflight: defineApplicationCommand<
    'settings:get-preflight',
    readonly [],
    StoreResult<'getPreflight'>
  >('settings:get-preflight'),
  getSettings: defineApplicationCommand<
    'settings:get-settings',
    readonly [],
    StoreResult<'getSettingsView'>
  >('settings:get-settings'),
  getSkillDetail: defineApplicationCommand<
    'settings:get-skill-detail',
    readonly [id: string],
    StoreResult<'getSkillDetail'>
  >('settings:get-skill-detail'),
  installClaude: defineApplicationCommand<
    'settings:install-claude',
    readonly [request: InstallClaudeRequest],
    StoreResult<'installClaude'>
  >('settings:install-claude'),
  installCodex: defineApplicationCommand<
    'settings:install-codex',
    readonly [request: InstallCodexRequest],
    StoreResult<'installCodex'>
  >('settings:install-codex'),
  installOpencode: defineApplicationCommand<
    'settings:install-opencode',
    readonly [request: InstallOpencodeRequest],
    StoreResult<'installOpencode'>
  >('settings:install-opencode'),
  isEncryptionAvailable: defineApplicationCommand<
    'settings:encryption-available',
    readonly [],
    StoreResult<'isEncryptionAvailable'>
  >('settings:encryption-available'),
  isNpmAvailable: defineApplicationCommand<
    'settings:npm-available',
    readonly [],
    StoreResult<'isNpmAvailable'>
  >('settings:npm-available'),
  listAppIcons: defineApplicationCommand<'settings:list-app-icons', readonly [], AppIconPreview[]>(
    'settings:list-app-icons'
  ),
  listConnectors: defineApplicationCommand<
    'settings:list-connectors',
    readonly [],
    StoreResult<'listConnectors'>
  >('settings:list-connectors'),
  listSkills: defineApplicationCommand<
    'settings:list-skills',
    readonly [],
    StoreResult<'listSkills'>
  >('settings:list-skills'),
  markOnboardingComplete: defineApplicationCommand<
    'settings:mark-onboarding-complete',
    readonly [],
    StoreResult<'markOnboardingComplete'>
  >('settings:mark-onboarding-complete'),
  previewAgentHomeSkill: defineApplicationCommand<
    'settings:preview-agent-home-skill',
    readonly [request: PreviewAgentHomeSkillRequest],
    StoreResult<'previewAgentHomeSkill'>
  >('settings:preview-agent-home-skill'),
  previewGitHubSkill: defineApplicationCommand<
    'settings:preview-github-skill',
    readonly [request: PreviewGitHubSkillRequest],
    StoreResult<'previewGitHubSkill'>
  >('settings:preview-github-skill'),
  previewSkillZip: defineApplicationCommand<
    'settings:preview-skill-zip',
    readonly [request: PreviewSkillZipRequest],
    StoreResult<'previewSkillZip'>
  >('settings:preview-skill-zip'),
  refreshProviderModels: defineApplicationCommand<
    'settings:refresh-provider-models',
    readonly [request: RefreshProviderModelsRequest],
    StoreResult<'refreshProviderModels'>
  >('settings:refresh-provider-models'),
  scanRepoSkills: defineApplicationCommand<
    'settings:scan-repo-skills',
    readonly [request: ScanRepoRequest],
    StoreResult<'scanRepoSkills'>
  >('settings:scan-repo-skills'),
  setAppIconVariant: defineApplicationCommand<
    'settings:set-app-icon-variant',
    readonly [request: SetAppIconVariantRequest],
    AppearanceResult
  >('settings:set-app-icon-variant'),
  setClosePreference: defineApplicationCommand<
    'settings:set-close-preference',
    readonly [request: SetClosePreferenceRequest],
    StoreResult<'setClosePreference'>
  >('settings:set-close-preference'),
  setDefaultPermissionProfile: defineApplicationCommand<
    'settings:set-default-permission-profile',
    readonly [request: SetDefaultPermissionProfileRequest],
    StoreResult<'setDefaultPermissionProfile'>
  >('settings:set-default-permission-profile'),
  setMemory: defineApplicationCommand<
    'settings:set-memory',
    readonly [memory: MemorySettings],
    StoreResult<'setMemory'>
  >('settings:set-memory'),
  setCredential: defineApplicationCommand<
    'settings:set-credential',
    readonly [request: SetCredentialRequest],
    StoreResult<'setCredential'>
  >('settings:set-credential'),
  deleteCredential: defineApplicationCommand<
    'settings:delete-credential',
    readonly [id: string],
    StoreResult<'deleteCredential'>
  >('settings:delete-credential'),
  testCredential: defineApplicationCommand<
    'settings:test-credential',
    readonly [request: TestCredentialRequest],
    StoreResult<'testCredential'>
  >('settings:test-credential'),
  setEgress: defineApplicationCommand<
    'settings:set-egress',
    readonly [egress: EgressSettings],
    StoreResult<'setEgress'>
  >('settings:set-egress'),
  setExternalComputeEndpoint: defineApplicationCommand<
    'settings:set-external-compute-endpoint',
    readonly [request: CreateExternalComputeEndpointRequest],
    StoreResult<'setExternalComputeEndpoint'>
  >('settings:set-external-compute-endpoint'),
  deleteExternalComputeEndpoint: defineApplicationCommand<
    'settings:delete-external-compute-endpoint',
    readonly [providerId: string],
    StoreResult<'deleteExternalComputeEndpoint'>
  >('settings:delete-external-compute-endpoint'),
  setNotificationsEnabled: defineApplicationCommand<
    'settings:set-notifications-enabled',
    readonly [request: SetNotificationsEnabledRequest],
    StoreResult<'setNotificationsEnabled'>
  >('settings:set-notifications-enabled'),
  setPackageMirror: defineApplicationCommand<
    'settings:set-package-mirror',
    readonly [request: SetPackageMirrorRequest],
    StoreResult<'setPackageMirror'>
  >('settings:set-package-mirror'),
  validateProvider: defineApplicationCommand<
    'settings:validate-provider',
    readonly [request: ValidateProviderRequest],
    StoreResult<'validateProvider'>
  >('settings:validate-provider'),
  xaiOauthStart: defineApplicationCommand<
    'settings:xai-oauth-start',
    readonly [],
    { session: unknown; browserOpened: boolean }
  >('settings:xai-oauth-start'),
  xaiOauthComplete: defineApplicationCommand<
    'settings:xai-oauth-complete',
    readonly [
      request: {
        providerId: string
        session: {
          deviceCode: string
          userCode: string
          verificationUrl: string
          expiresIn: number
          interval: number
        }
      }
    ],
    StoreResult<'completeXaiSignIn'>
  >('settings:xai-oauth-complete'),
  xaiOauthRefresh: defineApplicationCommand<
    'settings:xai-oauth-refresh',
    readonly [request: { providerId: string }],
    StoreResult<'refreshXaiOauth'>
  >('settings:xai-oauth-refresh'),
  xaiOauthStatus: defineApplicationCommand<
    'settings:xai-oauth-status',
    readonly [request: { providerId: string }],
    StoreResult<'xaiOauthStatus'>
  >('settings:xai-oauth-status'),
  xaiOauthLogout: defineApplicationCommand<
    'settings:xai-oauth-logout',
    readonly [request: { providerId: string }],
    StoreResult<'logoutXai'>
  >('settings:xai-oauth-logout'),
  exportMcpServers: defineApplicationCommand<
    'settings:export-mcp-servers',
    readonly [],
    Record<string, unknown>
  >('settings:export-mcp-servers'),
  importMcpServers: defineApplicationCommand<
    'settings:import-mcp-servers',
    readonly [json: unknown],
    { imported: string[]; skipped: string[] }
  >('settings:import-mcp-servers')
})

const settingsCoreApplicationCommandGroup = defineApplicationCommandGroup('settings-core', [
  settingsCoreApplicationCommands.cancelClaudeLogin,
  settingsCoreApplicationCommands.cancelCodexLogin,
  settingsCoreApplicationCommands.cancelIsolatedClaudeLogin,
  settingsCoreApplicationCommands.checkEnvironment,
  settingsCoreApplicationCommands.detectClaude,
  settingsCoreApplicationCommands.detectCodex,
  settingsCoreApplicationCommands.detectOpencode,
  settingsCoreApplicationCommands.getConnectorDetail,
  settingsCoreApplicationCommands.getMemory,
  settingsCoreApplicationCommands.getCredentials,
  settingsCoreApplicationCommands.getEgress,
  settingsCoreApplicationCommands.getExternalComputeEndpoints,
  settingsCoreApplicationCommands.getPackageMirror,
  settingsCoreApplicationCommands.getPreflight,
  settingsCoreApplicationCommands.getSettings,
  settingsCoreApplicationCommands.getSkillDetail,
  settingsCoreApplicationCommands.installClaude,
  settingsCoreApplicationCommands.installCodex,
  settingsCoreApplicationCommands.installOpencode,
  settingsCoreApplicationCommands.isEncryptionAvailable,
  settingsCoreApplicationCommands.isNpmAvailable,
  settingsCoreApplicationCommands.listAppIcons,
  settingsCoreApplicationCommands.listConnectors,
  settingsCoreApplicationCommands.listSkills,
  settingsCoreApplicationCommands.markOnboardingComplete,
  settingsCoreApplicationCommands.previewAgentHomeSkill,
  settingsCoreApplicationCommands.previewGitHubSkill,
  settingsCoreApplicationCommands.previewSkillZip,
  settingsCoreApplicationCommands.refreshProviderModels,
  settingsCoreApplicationCommands.scanRepoSkills,
  settingsCoreApplicationCommands.setAppIconVariant,
  settingsCoreApplicationCommands.setClosePreference,
  settingsCoreApplicationCommands.setDefaultPermissionProfile,
  settingsCoreApplicationCommands.setMemory,
  settingsCoreApplicationCommands.setCredential,
  settingsCoreApplicationCommands.deleteCredential,
  settingsCoreApplicationCommands.testCredential,
  settingsCoreApplicationCommands.setEgress,
  settingsCoreApplicationCommands.setExternalComputeEndpoint,
  settingsCoreApplicationCommands.deleteExternalComputeEndpoint,
  settingsCoreApplicationCommands.setNotificationsEnabled,
  settingsCoreApplicationCommands.setPackageMirror,
  settingsCoreApplicationCommands.validateProvider,
  settingsCoreApplicationCommands.xaiOauthStart,
  settingsCoreApplicationCommands.xaiOauthComplete,
  settingsCoreApplicationCommands.xaiOauthRefresh,
  settingsCoreApplicationCommands.xaiOauthStatus,
  settingsCoreApplicationCommands.xaiOauthLogout,
  settingsCoreApplicationCommands.exportMcpServers,
  settingsCoreApplicationCommands.importMcpServers
] as const)

type CoreSettingsApplicationCommandDependencies = Readonly<{
  service: CoreSettingsCommandStore
  appearance: Pick<AppearanceSettingsWorkflows, 'setAppIconVariant'>
  emitInstallEvent: (event: ClaudeInstallEvent) => void
  listAppIconPreviews?: () => AppIconPreview[]
}>

const requireLocalCaller = (context: CallerContext, channel: string): void => {
  if (context.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${channel}`)
  }
}

const registerCoreSettingsApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: CoreSettingsApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()

  try {
    scope.registerGroup(settingsCoreApplicationCommandGroup, {
      'settings:cancel-claude-login': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:cancel-claude-login')
        return dependencies.service.cancelClaudeLogin()
      },
      'settings:cancel-codex-login': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:cancel-codex-login')
        return dependencies.service.cancelCodexLogin()
      },
      'settings:cancel-isolated-claude-login': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:cancel-isolated-claude-login')
        return dependencies.service.cancelClaudeIsolatedLogin()
      },
      'settings:check-environment': () => dependencies.service.checkEnvironment(),
      'settings:detect-claude': () => dependencies.service.detectClaude(),
      'settings:detect-codex': () => dependencies.service.detectCodex(),
      'settings:detect-opencode': () => dependencies.service.detectOpencode(),
      'settings:get-connector-detail': ({ args }) =>
        dependencies.service.getConnectorDetail(args[0]),
      'settings:get-package-mirror': () => dependencies.service.getPackageMirror(),
      'settings:get-preflight': () => dependencies.service.getPreflight(),
      'settings:get-settings': () => dependencies.service.getSettingsView(),
      'settings:get-skill-detail': ({ args }) => dependencies.service.getSkillDetail(args[0]),
      'settings:install-claude': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:install-claude')
        return dependencies.service.installClaude(args[0], dependencies.emitInstallEvent)
      },
      'settings:install-codex': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:install-codex')
        return dependencies.service.installCodex(args[0], dependencies.emitInstallEvent)
      },
      'settings:install-opencode': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:install-opencode')
        return dependencies.service.installOpencode(args[0], dependencies.emitInstallEvent)
      },
      'settings:encryption-available': () => dependencies.service.isEncryptionAvailable(),
      'settings:npm-available': () => dependencies.service.isNpmAvailable(),
      'settings:list-app-icons': () => dependencies.listAppIconPreviews?.() ?? [],
      'settings:list-connectors': () => dependencies.service.listConnectors(),
      'settings:list-skills': () => dependencies.service.listSkills(),
      'settings:mark-onboarding-complete': () => dependencies.service.markOnboardingComplete(),
      'settings:preview-agent-home-skill': ({ args }) =>
        dependencies.service.previewAgentHomeSkill(args[0]),
      'settings:preview-github-skill': ({ args }) =>
        dependencies.service.previewGitHubSkill(args[0]),
      'settings:preview-skill-zip': ({ args }) => dependencies.service.previewSkillZip(args[0]),
      'settings:refresh-provider-models': ({ args }) =>
        dependencies.service.refreshProviderModels(args[0]),
      'settings:scan-repo-skills': ({ args }) => dependencies.service.scanRepoSkills(args[0]),
      'settings:set-app-icon-variant': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-app-icon-variant')
        return dependencies.appearance.setAppIconVariant(readAppIconVariant(args[0]))
      },
      'settings:set-close-preference': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-close-preference')
        return dependencies.service.setClosePreference(readClosePreference(args[0]))
      },
      'settings:set-default-permission-profile': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-default-permission-profile')
        return dependencies.service.setDefaultPermissionProfile(
          readDefaultPermissionProfile(args[0])
        )
      },
      'settings:set-notifications-enabled': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-notifications-enabled')
        return dependencies.service.setNotificationsEnabled(readNotificationsEnabled(args[0]))
      },
      'settings:get-memory': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:get-memory')
        return dependencies.service.getMemory()
      },
      'settings:set-memory': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-memory')
        return dependencies.service.setMemory(args[0])
      },
      'settings:list-credentials': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:list-credentials')
        return dependencies.service.listCredentials()
      },
      'settings:set-credential': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-credential')
        return dependencies.service.setCredential(args[0])
      },
      'settings:delete-credential': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:delete-credential')
        return dependencies.service.deleteCredential(args[0])
      },
      'settings:test-credential': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:test-credential')
        return dependencies.service.testCredential(args[0].id, args[0].secret)
      },
      'settings:get-egress': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:get-egress')
        return dependencies.service.getEgress()
      },
      'settings:set-egress': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-egress')
        return dependencies.service.setEgress(args[0])
      },
      'settings:list-external-compute-endpoints': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:list-external-compute-endpoints')
        return dependencies.service.listExternalComputeEndpoints()
      },
      'settings:set-external-compute-endpoint': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-external-compute-endpoint')
        return dependencies.service.setExternalComputeEndpoint(args[0])
      },
      'settings:delete-external-compute-endpoint': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:delete-external-compute-endpoint')
        return dependencies.service.deleteExternalComputeEndpoint(args[0])
      },
      'settings:set-package-mirror': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-package-mirror')
        return dependencies.service.setPackageMirror(args[0])
      },
      'settings:validate-provider': ({ args }) => dependencies.service.validateProvider(args[0]),
      'settings:xai-oauth-start': () => dependencies.service.startXaiSignIn(),
      'settings:xai-oauth-complete': ({ args }) =>
        dependencies.service.completeXaiSignIn(args[0].providerId, args[0].session),
      'settings:xai-oauth-refresh': ({ args }) =>
        dependencies.service.refreshXaiOauth(args[0].providerId),
      'settings:xai-oauth-status': ({ args }) =>
        dependencies.service.xaiOauthStatus(args[0].providerId),
      'settings:xai-oauth-logout': ({ args }) => dependencies.service.logoutXai(args[0].providerId),
      'settings:export-mcp-servers': () => dependencies.service.exportMcpServers(),
      'settings:import-mcp-servers': ({ args }) => dependencies.service.importMcpServers(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  registerCoreSettingsApplicationCommands,
  settingsCoreApplicationCommandGroup,
  settingsCoreApplicationCommands
}
export type { CoreSettingsApplicationCommandDependencies, CoreSettingsCommandStore }
