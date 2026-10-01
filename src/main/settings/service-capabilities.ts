import type { SettingsService } from './service'

// Transitional structural capabilities for callers that still consume the SettingsService façade.
// They keep integration modules independent of the concrete class while the façade remains available
// for compatibility through T3.
// The function-model pair travels together: the ACP layer asks what a function will use, and reports back
// what it did with it. Splitting them across two capabilities would let one exist without the other.
export type AcpSettingsCapabilities = Pick<
  SettingsService,
  | 'captureActiveAgentBackendSelection'
  | 'resolveAgentBackend'
  | 'resolveExplicitAgentBackend'
  | 'getVisionModelTarget'
  | 'recordFunctionModelEvent'
  | 'resolveFunctionModelTarget'
  | 'skillsNeedingForceLoad'
  | 'skillNudgeNamesForIds'
  | 'codexSkillDescriptorsForIds'
  | 'codexSkillCatalog'
  | 'getConversationSkillImportEnabled'
  | 'listSpecialistSkillCatalog'
  | 'provisionedConnectorSkillNames'
>

export type WindowSettingsCapabilities = Pick<
  SettingsService,
  'getAppIconVariant' | 'getClosePreference' | 'setClosePreference'
>
