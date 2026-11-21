import type { PackageMirror } from '../../../shared/mirror'
import type {
  AppIconVariant,
  ExportAuthorKind,
  ReasoningEffort,
  SettingsSnapshot
} from '../../../shared/settings'
import type { CloseActionPreference } from '../../../shared/window-controls'
import type { PermissionProfileId } from '../../../shared/permission-profiles'
import { isMirrorConfigured } from '../pages/settings/mirror-view'
import { SETTINGS_WRITE_ERROR_KEYS, type SettingsWriteErrorKey } from './settings-write-error-keys'
import type {
  OptimisticSettingsWriteKey,
  SettingsWriteCoordinator
} from './settings-write-coordinator'

type SettingsPreferencesState = {
  onboardingCompletedAt?: number
  packageMirror?: PackageMirror
  reasoningEffort: ReasoningEffort
  notificationsEnabled: boolean
  conversationSkillImportEnabled: boolean
  closePreference: CloseActionPreference | undefined
  useIntent: 'commercial' | 'non-commercial' | undefined
  appIconVariant: AppIconVariant
  // 导出署名与许可：'' 表示用户清空了；undefined 表示从没设过。两者导出时都不写字段。
  exportAuthor: string
  // 署名类型：只决定导出里那个实体的 `@type`；没选过按 'person'（与历史行为一致）。
  exportAuthorKind: ExportAuthorKind
  exportLicense: string
  defaultPermissionProfile: PermissionProfileId
}

type OptimisticPreferenceField =
  | 'reasoningEffort'
  | 'notificationsEnabled'
  | 'conversationSkillImportEnabled'
  | 'closePreference'
  | 'useIntent'
  | 'appIconVariant'
  | 'defaultPermissionProfile'
  | 'exportAuthor'
  | 'exportAuthorKind'
  | 'exportLicense'

export type SettingsPreferencesActions = {
  setReasoningEffort: (effort: ReasoningEffort) => Promise<void>
  setNotificationsEnabled: (enabled: boolean) => Promise<void>
  setConversationSkillImportEnabled: (enabled: boolean) => Promise<void>
  setClosePreference: (preference: CloseActionPreference | undefined) => Promise<void>
  setUseIntent: (intent: 'commercial' | 'non-commercial') => Promise<void>
  setAppIconVariant: (variant: AppIconVariant) => Promise<void>
  setDefaultPermissionProfile: (profile: PermissionProfileId) => Promise<void>
  setExportAuthor: (author: string) => Promise<void>
  setExportAuthorKind: (kind: ExportAuthorKind) => Promise<void>
  setExportLicense: (license: string) => Promise<void>
  completeOnboarding: () => Promise<void>
  setPackageMirror: (mirror: PackageMirror) => Promise<void>
}

type SettingsPreferencesCommands = Pick<
  Window['api']['settings'],
  | 'setReasoningEffort'
  | 'setNotificationsEnabled'
  | 'setConversationSkillImportEnabled'
  | 'setClosePreference'
  | 'setUseIntent'
  | 'setAppIconVariant'
  | 'setDefaultPermissionProfile'
  | 'setExportAuthor'
  | 'setExportLicense'
  | 'markOnboardingComplete'
  | 'setPackageMirror'
>

type SettingsPreferencesSliceOptions = {
  getState: () => SettingsPreferencesState
  setState: (patch: Partial<SettingsPreferencesState>) => void
  getCommands: () => SettingsPreferencesCommands
  reconcileSnapshot: (snapshot: SettingsSnapshot) => void
  writeCoordinator: SettingsWriteCoordinator
}

const SETTINGS_WRITE_ERRORS: Record<OptimisticSettingsWriteKey, SettingsWriteErrorKey> = {
  reasoningEffort: SETTINGS_WRITE_ERROR_KEYS.reasoningEffort,
  notifications: SETTINGS_WRITE_ERROR_KEYS.notifications,
  conversationSkillImport: SETTINGS_WRITE_ERROR_KEYS.conversationSkillImport,
  closePreference: SETTINGS_WRITE_ERROR_KEYS.closePreference,
  useIntent: SETTINGS_WRITE_ERROR_KEYS.useIntent,
  appIcon: SETTINGS_WRITE_ERROR_KEYS.appIcon,
  defaultPermissionProfile: SETTINGS_WRITE_ERROR_KEYS.defaultPermissionProfile,
  exportAuthor: SETTINGS_WRITE_ERROR_KEYS.exportAuthor,
  // 类型与文字是同一条命令的两次写入，失败提示也共用一句：分开报会让读者以为存了两份东西。
  exportAuthorKind: SETTINGS_WRITE_ERROR_KEYS.exportAuthor,
  exportLicense: SETTINGS_WRITE_ERROR_KEYS.exportLicense
}

// Owns renderer preference commands and their optimistic settlement. Core remains the sole owner of
// full Settings snapshots so every successful preference write still reconciles atomically.
export const createSettingsPreferencesSlice = ({
  getState,
  setState,
  getCommands,
  reconcileSnapshot,
  writeCoordinator
}: SettingsPreferencesSliceOptions): SettingsPreferencesActions => {
  const runOptimisticWrite = async <Field extends OptimisticPreferenceField>(
    field: Field,
    key: OptimisticSettingsWriteKey,
    value: SettingsPreferencesState[Field],
    command: () => Promise<SettingsSnapshot>,
    consoleMessage: string
  ): Promise<void> => {
    const write = writeCoordinator.beginOptimistic(key, getState()[field])
    setState({ [field]: value } as Partial<SettingsPreferencesState>)

    try {
      const snapshot = await write.run(command)
      write.complete({ value: snapshot[field] as SettingsPreferencesState[Field] })
      if (!write.isCurrent()) return
      reconcileSnapshot(snapshot)
      write.succeed()
    } catch (error) {
      const confirmedValue = write.complete()
      if (write.isCurrent()) {
        setState({ [field]: confirmedValue } as Partial<SettingsPreferencesState>)
      }
      write.fail(SETTINGS_WRITE_ERRORS[key])
      console.error(consoleMessage, error)
    }
  }

  return {
    setReasoningEffort: (effort) =>
      runOptimisticWrite(
        'reasoningEffort',
        'reasoningEffort',
        effort,
        () => getCommands().setReasoningEffort({ effort }),
        'Failed to set reasoning effort'
      ),

    setNotificationsEnabled: (enabled) =>
      runOptimisticWrite(
        'notificationsEnabled',
        'notifications',
        enabled,
        () => getCommands().setNotificationsEnabled({ enabled }),
        'Failed to set notifications enabled'
      ),

    setConversationSkillImportEnabled: (enabled) =>
      runOptimisticWrite(
        'conversationSkillImportEnabled',
        'conversationSkillImport',
        enabled,
        () => getCommands().setConversationSkillImportEnabled({ enabled }),
        'Failed to set conversation Skill import enabled'
      ),

    setClosePreference: (preference) =>
      runOptimisticWrite(
        'closePreference',
        'closePreference',
        preference,
        () => getCommands().setClosePreference({ preference }),
        'Failed to set close preference'
      ),

    setUseIntent: (intent) =>
      runOptimisticWrite(
        'useIntent',
        'useIntent',
        intent,
        () => getCommands().setUseIntent(intent),
        'Failed to set use intent'
      ),

    setAppIconVariant: (variant) =>
      runOptimisticWrite(
        'appIconVariant',
        'appIcon',
        variant,
        () => getCommands().setAppIconVariant({ variant }),
        'Failed to set app icon variant'
      ),

    setDefaultPermissionProfile: (profile) =>
      runOptimisticWrite(
        'defaultPermissionProfile',
        'defaultPermissionProfile',
        profile,
        () => getCommands().setDefaultPermissionProfile({ profile }),
        'Failed to set default permission profile'
      ),

    // 空串就是「清除」：主进程会把 '' 存成 undefined，导出时也就不写这两个字段。
    setExportAuthor: (author) =>
      runOptimisticWrite(
        'exportAuthor',
        'exportAuthor',
        author,
        () =>
          getCommands().setExportAuthor({ value: author, authorKind: getState().exportAuthorKind }),
        'Failed to set export author'
      ),

    // 类型跟着同一条命令走：只改 `@type`，文字一个字节不动，所以这里把当前文字一起带上。
    setExportAuthorKind: (kind) =>
      runOptimisticWrite(
        'exportAuthorKind',
        'exportAuthorKind',
        kind,
        () => getCommands().setExportAuthor({ value: getState().exportAuthor, authorKind: kind }),
        'Failed to set export author kind'
      ),

    setExportLicense: (license) =>
      runOptimisticWrite(
        'exportLicense',
        'exportLicense',
        license,
        () => getCommands().setExportLicense({ value: license }),
        'Failed to set export license'
      ),

    completeOnboarding: async () => {
      reconcileSnapshot(await getCommands().markOnboardingComplete())
    },

    setPackageMirror: async (mirror) => {
      const saved = await getCommands().setPackageMirror(mirror)
      setState({ packageMirror: isMirrorConfigured(saved) ? saved : undefined })
    }
  }
}
