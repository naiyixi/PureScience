import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SettingsPreferencesModule } from './preferences'
import { SettingsRepository } from './repository'

const roots: string[] = []

const createModule = async (
  now = 1_000
): Promise<{
  preferences: SettingsPreferencesModule
  repository: SettingsRepository
  root: string
}> => {
  const root = await mkdtemp(join(tmpdir(), 'settings-preferences-'))
  roots.push(root)
  const repository = new SettingsRepository(root)
  return { preferences: new SettingsPreferencesModule(repository, () => now), repository, root }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SettingsPreferencesModule', () => {
  it('resolves preference defaults without exposing the stored document', async () => {
    const { preferences } = await createModule()

    await expect(preferences.getSnapshot()).resolves.toEqual({
      reasoningEffort: 'default',
      notificationsEnabled: true,
      conversationSkillImportEnabled: true,
      appIconVariant: 'light',
      defaultPermissionProfile: 'ask'
    })
  })

  it('persists scalar commands with the existing defaults and one-time markers', async () => {
    const { preferences, repository } = await createModule(2_000)
    const dataRoot = resolve('/data/purescience')

    await preferences.setReasoningEffort('high')
    await preferences.setNotificationsEnabled(false)
    await preferences.setConversationSkillImportEnabled(false)
    await preferences.setClosePreference('quit')
    await preferences.setAppIconVariant('dark')
    await preferences.setDefaultPermissionProfile('auto')
    await preferences.setDataRoot(dataRoot)
    await preferences.markOnboardingComplete()
    await preferences.markPathsNormalized()
    await preferences.dismissLegacyDataMovePrompt()

    await expect(preferences.getSnapshot()).resolves.toEqual({
      onboardingCompletedAt: 2_000,
      pathsNormalizedAt: 2_000,
      legacyDataMovePromptDismissedAt: 2_000,
      dataRoot,
      reasoningEffort: 'high',
      notificationsEnabled: false,
      conversationSkillImportEnabled: false,
      closePreference: 'quit',
      appIconVariant: 'dark',
      defaultPermissionProfile: 'auto'
    })

    await preferences.setClosePreference(undefined)
    await preferences.markOnboardingComplete()
    await expect(repository.getSettings()).resolves.toMatchObject({
      onboardingCompletedAt: 2_000,
      pathsNormalizedAt: 2_000,
      legacyDataMovePromptDismissedAt: 2_000,
      dataRoot,
      reasoningEffort: 'high',
      notificationsEnabled: false,
      conversationSkillImportEnabled: false,
      appIconVariant: 'dark',
      defaultPermissionProfile: 'auto'
    })
    expect((await repository.getSettings()).closePreference).toBeUndefined()
  })

  it('records the interface language the renderer reported, and drops a junk value', async () => {
    const { preferences, repository, root } = await createModule()

    // Absent until the renderer reports one: nothing invents a language on the app's behalf.
    await expect(preferences.getSnapshot()).resolves.not.toHaveProperty('uiLanguage')

    await preferences.setUiLanguage('zh-Hant')
    await expect(preferences.getSnapshot()).resolves.toMatchObject({ uiLanguage: 'zh-Hant' })
    await expect(repository.getSettings()).resolves.toMatchObject({ uiLanguage: 'zh-Hant' })

    // A bounded language tag, not prose: an over-long value is not a language and is dropped on load.
    const settingsPath = join(root, 'settings.json')
    const onDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    onDisk.uiLanguage = 'x'.repeat(40)
    await writeFile(settingsPath, JSON.stringify(onDisk))
    const reloaded = new SettingsPreferencesModule(new SettingsRepository(root))
    await expect(reloaded.getSnapshot()).resolves.not.toHaveProperty('uiLanguage')
  })
})
