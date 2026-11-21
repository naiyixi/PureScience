import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { PackageMirror } from '../../../shared/mirror'
import type {
  AppIconVariant,
  ExportAuthorKind,
  ReasoningEffort,
  SettingsSnapshot
} from '../../../shared/settings'
import type { CloseActionPreference } from '../../../shared/window-controls'
import type { PermissionProfileId } from '../../../shared/permission-profiles'
import {
  createSettingsPreferencesSlice,
  type SettingsPreferencesActions
} from './settings-preferences-slice'
import { createSettingsWriteCoordinator } from './settings-write-coordinator'

type PreferencesCommands = Pick<
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

type CommandMocks = { [Command in keyof PreferencesCommands]: Mock }

type TestStore = SettingsPreferencesActions & {
  onboardingCompletedAt?: number
  packageMirror?: PackageMirror
  reasoningEffort: ReasoningEffort
  notificationsEnabled: boolean
  conversationSkillImportEnabled: boolean
  closePreference: CloseActionPreference | undefined
  useIntent: 'commercial' | 'non-commercial' | undefined
  appIconVariant: AppIconVariant
  exportAuthor: string
  exportAuthorKind: ExportAuthorKind
  exportAffiliation: string
  exportLicense: string
  defaultPermissionProfile: PermissionProfileId
  settingsWriteError: string | undefined
}

const snapshot = (patch: Partial<SettingsSnapshot> = {}): SettingsSnapshot => ({
  claude: {},
  activeProviderId: undefined,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  opencode: {},
  codebuddy: {},
  codex: {},
  claudeManaged: false,
  opencodeManaged: false,
  codebuddyManaged: false,
  codexManaged: false,
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light',
  defaultPermissionProfile: 'ask',
  ...patch
})

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} => {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const createCommands = (): CommandMocks => ({
  setReasoningEffort: vi.fn(({ effort }) => Promise.resolve(snapshot({ reasoningEffort: effort }))),
  setNotificationsEnabled: vi.fn(({ enabled }) =>
    Promise.resolve(snapshot({ notificationsEnabled: enabled }))
  ),
  setConversationSkillImportEnabled: vi.fn(({ enabled }) =>
    Promise.resolve(snapshot({ conversationSkillImportEnabled: enabled }))
  ),
  setClosePreference: vi.fn(({ preference }) =>
    Promise.resolve(snapshot({ closePreference: preference }))
  ),
  setUseIntent: vi.fn((intent) => Promise.resolve(snapshot({ useIntent: intent }))),
  setAppIconVariant: vi.fn(({ variant }) => Promise.resolve(snapshot({ appIconVariant: variant }))),
  setDefaultPermissionProfile: vi.fn(({ profile }) =>
    Promise.resolve(snapshot({ defaultPermissionProfile: profile }))
  ),
  setExportAuthor: vi.fn(({ value, authorKind, affiliation }) =>
    Promise.resolve(
      snapshot({
        exportAuthor: value,
        ...(authorKind ? { exportAuthorKind: authorKind } : {}),
        ...(affiliation === undefined ? {} : { exportAffiliation: affiliation })
      })
    )
  ),
  setExportLicense: vi.fn(({ value }) => Promise.resolve(snapshot({ exportLicense: value }))),
  markOnboardingComplete: vi.fn().mockResolvedValue(snapshot({ onboardingCompletedAt: 42 })),
  setPackageMirror: vi.fn((mirror) => Promise.resolve(mirror))
})

const createHarness = (): {
  commands: CommandMocks
  reconcileSnapshot: Mock
  store: StoreApi<TestStore>
} => {
  const commands = createCommands()
  const reconcileSnapshot = vi.fn((next: SettingsSnapshot) => {
    store.setState({
      onboardingCompletedAt: next.onboardingCompletedAt,
      packageMirror: next.packageMirror,
      reasoningEffort: next.reasoningEffort,
      notificationsEnabled: next.notificationsEnabled,
      conversationSkillImportEnabled: next.conversationSkillImportEnabled,
      closePreference: next.closePreference,
      useIntent: next.useIntent,
      appIconVariant: next.appIconVariant,
      exportAuthor: next.exportAuthor ?? '',
      exportAuthorKind: next.exportAuthorKind ?? 'person',
      exportAffiliation: next.exportAffiliation ?? '',
      exportLicense: next.exportLicense ?? '',
      defaultPermissionProfile: next.defaultPermissionProfile ?? 'ask'
    })
  })
  const store = createStore<TestStore>((set, get) => ({
    reasoningEffort: 'default',
    notificationsEnabled: true,
    conversationSkillImportEnabled: true,
    closePreference: undefined,
    useIntent: undefined,
    appIconVariant: 'light',
    exportAuthor: '',
    exportAuthorKind: 'person',
    exportAffiliation: '',
    exportLicense: '',
    defaultPermissionProfile: 'ask',
    settingsWriteError: undefined,
    ...createSettingsPreferencesSlice({
      getState: get,
      setState: (patch) => set(patch),
      getCommands: () => commands as unknown as PreferencesCommands,
      reconcileSnapshot,
      writeCoordinator: createSettingsWriteCoordinator((settingsWriteError) =>
        set({ settingsWriteError })
      )
    })
  }))

  return { commands, reconcileSnapshot, store }
}

describe('settings preferences slice', () => {
  let commands: CommandMocks
  let reconcileSnapshot: Mock
  let store: StoreApi<TestStore>

  beforeEach(() => {
    vi.restoreAllMocks()
    ;({ commands, reconcileSnapshot, store } = createHarness())
  })

  it('forwards preference writes and reconciles each returned snapshot', async () => {
    await store.getState().setReasoningEffort('high')
    await store.getState().setNotificationsEnabled(false)
    await store.getState().setConversationSkillImportEnabled(false)
    await store.getState().setClosePreference('minimize')
    await store.getState().setAppIconVariant('dark')
    await store.getState().setDefaultPermissionProfile('auto')

    expect(commands.setReasoningEffort).toHaveBeenCalledWith({ effort: 'high' })
    expect(commands.setNotificationsEnabled).toHaveBeenCalledWith({ enabled: false })
    expect(commands.setConversationSkillImportEnabled).toHaveBeenCalledWith({ enabled: false })
    expect(commands.setClosePreference).toHaveBeenCalledWith({ preference: 'minimize' })
    expect(commands.setAppIconVariant).toHaveBeenCalledWith({ variant: 'dark' })
    expect(commands.setDefaultPermissionProfile).toHaveBeenCalledWith({ profile: 'auto' })
    expect(reconcileSnapshot).toHaveBeenCalledTimes(6)
  })

  it('carries the affiliation through every writer, so changing the name or the kind cannot drop it', async () => {
    await store.getState().setExportAffiliation('浙江大学医学院附属第二医院')
    await store.getState().setExportAuthor('Abel Wang')
    await store.getState().setExportAuthorKind('person')

    // 三次写入都必须带上机构：省略 affiliation 在主进程那里的含义是「这次没提，保留旧值」，
    // 而清空是空串 —— 所以只要少带一次，用户就会看到「机构自己没了」或「清不掉」。
    expect(commands.setExportAuthor).toHaveBeenNthCalledWith(1, {
      value: '',
      authorKind: 'person',
      affiliation: '浙江大学医学院附属第二医院'
    })
    expect(commands.setExportAuthor).toHaveBeenNthCalledWith(2, {
      value: 'Abel Wang',
      authorKind: 'person',
      affiliation: '浙江大学医学院附属第二医院'
    })
    expect(commands.setExportAuthor).toHaveBeenNthCalledWith(3, {
      value: 'Abel Wang',
      authorKind: 'person',
      affiliation: '浙江大学医学院附属第二医院'
    })
    expect(store.getState().exportAffiliation).toBe('浙江大学医学院附属第二医院')
  })

  it('carries the author type and the author text in the same write, so neither silently overwrites the other', async () => {
    await store.getState().setExportAuthor('zerolink Bio')
    await store.getState().setExportAuthorKind('organization')

    expect(commands.setExportAuthor).toHaveBeenNthCalledWith(1, {
      value: 'zerolink Bio',
      authorKind: 'person',
      affiliation: ''
    })
    // The second write names the text it is not changing, and the kind it is: a partial payload would
    // let the main process clear whichever half it did not receive.
    expect(commands.setExportAuthor).toHaveBeenNthCalledWith(2, {
      value: 'zerolink Bio',
      authorKind: 'organization',
      affiliation: ''
    })
    expect(store.getState().exportAuthorKind).toBe('organization')
  })

  it('applies immediately, then rolls back and exposes the unchanged failure copy', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const pending = deferred<SettingsSnapshot>()
    commands.setReasoningEffort.mockReturnValue(pending.promise)

    const write = store.getState().setReasoningEffort('max')
    expect(store.getState().reasoningEffort).toBe('max')

    pending.reject(new Error('ipc down'))
    await write

    expect(store.getState().reasoningEffort).toBe('default')
    expect(store.getState().settingsWriteError).toBe('settings.saveFailedReasoningEffort')
    expect(consoleError).toHaveBeenCalledWith('Failed to set reasoning effort', expect.any(Error))
  })

  it('serializes same-key writes and keeps the last confirmed value when the newer write fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = deferred<SettingsSnapshot>()
    commands.setReasoningEffort
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('newer failure'))

    const olderWrite = store.getState().setReasoningEffort('high')
    const newerWrite = store.getState().setReasoningEffort('max')

    expect(commands.setReasoningEffort).toHaveBeenCalledTimes(1)
    first.resolve(snapshot({ reasoningEffort: 'high' }))
    await Promise.all([olderWrite, newerWrite])

    expect(commands.setReasoningEffort).toHaveBeenCalledTimes(2)
    expect(store.getState().reasoningEffort).toBe('high')
    expect(store.getState().settingsWriteError).toBe('settings.saveFailedReasoningEffort')
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('keeps onboarding and package-mirror settlement non-optimistic', async () => {
    await store.getState().completeOnboarding()
    await store.getState().setPackageMirror({ pypiIndex: 'https://mirror.example/simple' })

    expect(store.getState().onboardingCompletedAt).toBe(42)
    expect(store.getState().packageMirror).toEqual({
      pypiIndex: 'https://mirror.example/simple'
    })

    commands.setPackageMirror.mockResolvedValueOnce({})
    await store.getState().setPackageMirror({})
    expect(store.getState().packageMirror).toBeUndefined()
  })
})
