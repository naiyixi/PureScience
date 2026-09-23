// Settings write failures cross the store/react boundary as dictionary keys, not prose: the store
// layer has no access to the i18n hook, and a hardcoded sentence there is untranslatable forever.
// Translation happens once, at the single place that renders `settingsWriteError`.
export const SETTINGS_WRITE_ERROR_KEYS = {
  reasoningEffort: 'settings.saveFailedReasoningEffort',
  notifications: 'settings.saveFailedNotifications',
  conversationSkillImport: 'settings.saveFailedConversationSkillImport',
  closePreference: 'settings.saveFailedClosePreference',
  useIntent: 'settings.saveFailedUseIntent',
  appIcon: 'settings.saveFailedAppIcon',
  defaultPermissionProfile: 'settings.saveFailedDefaultPermissionProfile',
  providerSwitch: 'settings.saveFailedProviderSwitch',
  agentFrameworkSwitch: 'settings.saveFailedAgentFrameworkSwitch',
  visionModel: 'settings.saveFailedVisionModel',
  scenarioModel: 'settings.saveFailedScenarioModel'
} as const

export type SettingsWriteErrorKey =
  (typeof SETTINGS_WRITE_ERROR_KEYS)[keyof typeof SETTINGS_WRITE_ERROR_KEYS]

const SETTINGS_WRITE_ERROR_KEY_SET: ReadonlySet<string> = new Set(
  Object.values(SETTINGS_WRITE_ERROR_KEYS)
)

// Write failures can also arrive as raw transport messages (an IPC error string straight from main),
// so the render site translates only what it recognizes and passes everything else through.
export const isSettingsWriteErrorKey = (
  value: string | undefined
): value is SettingsWriteErrorKey => value !== undefined && SETTINGS_WRITE_ERROR_KEY_SET.has(value)
