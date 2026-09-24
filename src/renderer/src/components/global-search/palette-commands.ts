import type { TranslationKey } from '@/i18n'
import type { SettingsPanelId } from '@/pages/settings/settings-navigation'

// A command the ⌘K palette can run. Kept as plain data (not JSX) so the catalog can be tested without a
// DOM, and so the same list can back a keyboard-shortcut surface without a second copy drifting away.
export type PaletteCommand = {
  id: string
  labelKey: TranslationKey
  // Search tokens beyond the label. These deliberately repeat what the settings search answers to, so
  // one query means one thing across both surfaces: "mirror" reaches the network panel from either.
  keywords: readonly string[]
  // Rendered next to the row when the chord is real, so the palette teaches it instead of hiding it.
  shortcut?: string
  run: () => void
}

export type PaletteCommandContext = {
  openSettings: () => void
  openSettingsToPanel: (panel: SettingsPanelId) => void
  openSettingsToCompute: () => void
  openKeyboardShortcuts: () => void
}

// Commands sit above the search results, so the list must not bury them under history.
export const PALETTE_COMMAND_LIMIT = 6

const SETTINGS_KEYWORDS = ['settings', 'preferences', '设置', '偏好'] as const

const panelCommand = (
  id: string,
  labelKey: TranslationKey,
  panel: SettingsPanelId,
  keywords: readonly string[],
  openSettingsToPanel: (panel: SettingsPanelId) => void
): PaletteCommand => ({
  id,
  labelKey,
  keywords: [...SETTINGS_KEYWORDS, ...keywords],
  run: () => openSettingsToPanel(panel)
})

export const buildPaletteCommands = ({
  openSettings,
  openSettingsToPanel,
  openSettingsToCompute,
  openKeyboardShortcuts
}: PaletteCommandContext): PaletteCommand[] => [
  {
    id: 'settings.open',
    labelKey: 'palette.openSettings',
    keywords: [...SETTINGS_KEYWORDS, 'cmd+comma', '⌘,'],
    shortcut: '⌘,',
    run: openSettings
  },
  {
    id: 'settings.network',
    labelKey: 'palette.settingsNetwork',
    keywords: ['network', 'proxy', 'mirror', 'registry', 'npm', '镜像', '代理', '网络'],
    run: () => openSettingsToPanel('network')
  },
  {
    id: 'settings.runtimes',
    labelKey: 'palette.settingsRuntimes',
    keywords: ['runtime', 'python', 'r', 'environment', 'mirror', '镜像', '运行环境', '环境'],
    run: () => openSettingsToPanel('runtimes')
  },
  panelCommand(
    'settings.model',
    'palette.settingsModel',
    'model',
    ['model', 'provider', 'api key', '模型', '密钥'],
    openSettingsToPanel
  ),
  {
    id: 'settings.compute',
    labelKey: 'palette.settingsCompute',
    keywords: ['compute', 'host', 'gpu', 'cluster', '计算', '主机'],
    run: openSettingsToCompute
  },
  panelCommand(
    'settings.storage',
    'palette.settingsStorage',
    'storage',
    ['storage', 'data root', 'disk', '存储', '数据目录'],
    openSettingsToPanel
  ),
  panelCommand(
    'settings.agent',
    'palette.settingsAgent',
    'agent',
    ['agent', 'prompt', 'instructions', '智能体', '提示词'],
    openSettingsToPanel
  ),
  {
    id: 'shortcuts.open',
    labelKey: 'palette.keyboardShortcuts',
    keywords: ['shortcut', 'keyboard', 'keys', 'chord', '快捷键', '键盘'],
    run: openKeyboardShortcuts
  }
]

const scoreCommand = (command: PaletteCommand, label: string, query: string): number => {
  if (label.startsWith(query)) return 0
  if (label.includes(query)) return 1
  if (command.keywords.some((keyword) => keyword.startsWith(query))) return 2
  if (command.keywords.some((keyword) => keyword.includes(query))) return 3
  return -1
}

// Ranked so a label hit always outranks a keyword hit: typing the visible name of a command must not be
// beaten by some other command's synonyms.
export const matchPaletteCommands = (
  commands: readonly PaletteCommand[],
  query: string,
  translate: (key: TranslationKey) => string,
  limit: number = PALETTE_COMMAND_LIMIT
): PaletteCommand[] => {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return commands.slice(0, limit)

  return commands
    .map((command) => ({
      command,
      score: scoreCommand(command, translate(command.labelKey).toLowerCase(), normalized)
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.command)
}
