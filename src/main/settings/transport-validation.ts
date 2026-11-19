import {
  isAppIconVariant,
  isReasoningEffort,
  type AppIconVariant,
  type ReasoningEffort
} from '../../shared/settings'
import type { CloseActionPreference } from '../../shared/window-controls'
import { isPermissionProfileId, type PermissionProfileId } from '../../shared/permission-profiles'

const readField = (value: unknown, field: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)[field]
    : undefined

const readNotificationsEnabled = (request: unknown): boolean => {
  const enabled = readField(request, 'enabled')
  if (typeof enabled !== 'boolean') {
    throw new Error(`Invalid notifications-enabled flag: ${String(enabled)}`)
  }
  return enabled
}

const readReasoningEffort = (request: unknown): ReasoningEffort => {
  const effort = readField(request, 'effort')
  if (!isReasoningEffort(effort)) {
    throw new Error(`Unknown reasoning effort: ${String(effort)}`)
  }
  return effort
}

const readConversationSkillImportEnabled = (request: unknown): boolean => {
  const enabled = readField(request, 'enabled')
  if (typeof enabled !== 'boolean') {
    throw new Error(`Invalid conversation-skill-import-enabled flag: ${String(enabled)}`)
  }
  return enabled
}

const readClosePreference = (request: unknown): CloseActionPreference | undefined => {
  const preference = readField(request, 'preference')
  if (preference !== undefined && preference !== 'minimize' && preference !== 'quit') {
    throw new Error(`Invalid close preference: ${String(preference)}`)
  }
  return preference
}

const readAppIconVariant = (request: unknown): AppIconVariant => {
  const variant = readField(request, 'variant')
  if (!isAppIconVariant(variant)) {
    throw new Error(`Unknown app icon variant: ${String(variant)}`)
  }
  return variant
}

// A language tag, not prose: letters/digits/separators only, bounded to the longest BCP-47 tag. An
// empty report is ignored (the stored language is kept) rather than clearing it.
const UI_LANGUAGE_PATTERN = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/
// 导出署名/许可的入参校验：这是会逐字进入导出包的自由文本，所以裁掉首尾空白、拒绝控制字符、长度封顶
// （200 字符足够写下机构名或许可证标识）。空值返回 undefined = 清除。
const ATTRIBUTION_MAX_LENGTH = 200
const readAttributionValue = (request: unknown): string | undefined => {
  const value = readField(request, 'value')
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`Invalid export attribution value: ${String(value)}`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > ATTRIBUTION_MAX_LENGTH) {
    throw new Error(`Export attribution value is longer than ${ATTRIBUTION_MAX_LENGTH} characters`)
  }
  // 控制字符（换行、制表、RTL 覆盖符等）会把 JSON-LD 字段变成不可读甚至误导的文本。
  // 逐字符判断而不是用带 \u0000-\u001f 的正则：那条正则会触发 no-control-regex，而这里要的语义
  // 正是「有没有控制字符」，用 codePointAt 写反而更直白。
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f || (code >= 0x202a && code <= 0x202e)
  })
  if (hasControlCharacter) {
    throw new Error('Export attribution value contains control characters')
  }
  return trimmed
}

const readUiLanguage = (request: unknown): string | undefined => {
  const language = readField(request, 'language')
  if (language === undefined || language === null) return undefined
  if (typeof language !== 'string') {
    throw new Error(`Invalid interface language: ${String(language)}`)
  }
  const trimmed = language.trim()
  if (trimmed.length === 0) return undefined
  if (!UI_LANGUAGE_PATTERN.test(trimmed)) {
    throw new Error(`Invalid interface language: ${trimmed}`)
  }
  return trimmed
}

const readDefaultPermissionProfile = (request: unknown): PermissionProfileId => {
  const profile = readField(request, 'profile')
  if (!isPermissionProfileId(profile)) {
    throw new Error(`Unknown default permission profile: ${String(profile)}`)
  }
  return profile
}

const readIsolatedClaudeToken = (token: unknown): string => {
  if (typeof token !== 'string') {
    throw new Error('Claude sign-in token must be a string.')
  }
  return token
}

export {
  readAppIconVariant,
  readClosePreference,
  readConversationSkillImportEnabled,
  readDefaultPermissionProfile,
  readIsolatedClaudeToken,
  readNotificationsEnabled,
  readReasoningEffort,
  readUiLanguage,
  readAttributionValue
}
