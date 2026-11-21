import { describe, expect, it } from 'vitest'

import {
  readClosePreference,
  readConversationSkillImportEnabled,
  readDefaultPermissionProfile,
  readAppIconVariant,
  readExportAffiliation,
  readExportAuthorKind,
  readIsolatedClaudeToken,
  readNotificationsEnabled,
  readReasoningEffort
} from './transport-validation'

describe('Settings transport validation', () => {
  it('accepts only boolean notification preferences with the Electron error contract', () => {
    expect(readNotificationsEnabled({ enabled: false })).toBe(false)
    expect(() => readNotificationsEnabled({ enabled: 'yes' })).toThrow(
      'Invalid notifications-enabled flag: yes'
    )
    expect(() => readNotificationsEnabled(undefined)).toThrow(
      'Invalid notifications-enabled flag: undefined'
    )
  })

  it('accepts only known reasoning efforts with the Electron error contract', () => {
    expect(readReasoningEffort({ effort: 'high' })).toBe('high')
    expect(() => readReasoningEffort({ effort: 'ultra' })).toThrow(
      'Unknown reasoning effort: ultra'
    )
    expect(() => readReasoningEffort({ effort: 3 })).toThrow('Unknown reasoning effort: 3')
    expect(() => readReasoningEffort({})).toThrow('Unknown reasoning effort: undefined')
  })

  it('accepts only boolean conversation Skill import preferences', () => {
    expect(readConversationSkillImportEnabled({ enabled: true })).toBe(true)
    expect(() => readConversationSkillImportEnabled({ enabled: 'yes' })).toThrow(
      'Invalid conversation-skill-import-enabled flag: yes'
    )
    expect(() => readConversationSkillImportEnabled(null)).toThrow(
      'Invalid conversation-skill-import-enabled flag: undefined'
    )
  })

  it('accepts minimize, quit, or an omitted close preference', () => {
    expect(readClosePreference({ preference: 'minimize' })).toBe('minimize')
    expect(readClosePreference({ preference: 'quit' })).toBe('quit')
    expect(readClosePreference({})).toBeUndefined()
    expect(() => readClosePreference({ preference: 'close' })).toThrow(
      'Invalid close preference: close'
    )
  })

  it('accepts only known app icon variants with the Electron error contract', () => {
    expect(readAppIconVariant({ variant: 'dark' })).toBe('dark')
    expect(() => readAppIconVariant({ variant: 'sparkle' })).toThrow(
      'Unknown app icon variant: sparkle'
    )
    expect(() => readAppIconVariant({})).toThrow('Unknown app icon variant: undefined')
  })

  it('accepts the two author kinds, and treats an absent one as "not stated"', () => {
    expect(readExportAuthorKind({ authorKind: 'person' })).toBe('person')
    expect(readExportAuthorKind({ authorKind: 'organization' })).toBe('organization')
    // Absent is not "person": the command must not silently overwrite a stored choice.
    expect(readExportAuthorKind({ value: 'zerolink Bio' })).toBeUndefined()
    expect(readExportAuthorKind(undefined)).toBeUndefined()
    expect(() => readExportAuthorKind({ authorKind: 'company' })).toThrow(
      'Invalid export author kind: company'
    )
    expect(() => readExportAuthorKind({ authorKind: true })).toThrow(
      'Invalid export author kind: true'
    )
  })

  it('keeps "affiliation not stated" apart from "affiliation cleared"', () => {
    // 缺失 = 这次没提机构：命令必须保留已存的那个值。
    expect(readExportAffiliation({ value: 'Abel Wang' })).toBeUndefined()
    expect(readExportAffiliation(undefined)).toBeUndefined()
    // 空串 = 用户清空了机构：返回空串而不是 undefined，否则清空会变成「什么都没发生」。
    expect(readExportAffiliation({ value: 'Abel Wang', affiliation: '   ' })).toBe('')
    expect(readExportAffiliation({ affiliation: '' })).toBe('')
    expect(readExportAffiliation({ affiliation: ' 浙江大学医学院附属第二医院 ' })).toBe(
      '浙江大学医学院附属第二医院'
    )
  })

  it('refuses an affiliation that would corrupt the JSON-LD field', () => {
    expect(() => readExportAffiliation({ affiliation: 42 })).toThrow(
      'Invalid export affiliation: 42'
    )
    expect(() => readExportAffiliation({ affiliation: 'a\nb' })).toThrow(
      'Export affiliation contains control characters'
    )
    expect(() => readExportAffiliation({ affiliation: 'x'.repeat(201) })).toThrow(
      'Export affiliation is longer than 200 characters'
    )
  })

  it('accepts only known default permission profiles', () => {
    expect(readDefaultPermissionProfile({ profile: 'auto' })).toBe('auto')
    expect(() => readDefaultPermissionProfile({ profile: 'always' })).toThrow(
      'Unknown default permission profile: always'
    )
    expect(() => readDefaultPermissionProfile({})).toThrow(
      'Unknown default permission profile: undefined'
    )
  })

  it('accepts only a string isolated Claude token', () => {
    expect(readIsolatedClaudeToken('sk-ant-test')).toBe('sk-ant-test')
    expect(() => readIsolatedClaudeToken(42)).toThrow('Claude sign-in token must be a string.')
    expect(() => readIsolatedClaudeToken(undefined)).toThrow(
      'Claude sign-in token must be a string.'
    )
  })
})
