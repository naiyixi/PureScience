import { describe, expect, it, vi } from 'vitest'

import type { TranslationKey } from '@/i18n'
import type { SettingsPanelId } from '@/pages/settings/settings-navigation'

import {
  buildPaletteCommands,
  matchPaletteCommands,
  PALETTE_COMMAND_LIMIT,
  type PaletteCommandContext
} from './palette-commands'

// Fallback labels for the keys this catalog uses. Deliberately not interpolated: the catalog is queried
// with plain text, so a plain dictionary is what the ranking should be checked against.
const LABELS: Partial<Record<TranslationKey, string>> = {
  'palette.openSettings': 'Open settings',
  'palette.settingsNetwork': 'Settings: Network & mirror',
  'palette.settingsRuntimes': 'Settings: Runtimes',
  'palette.settingsModel': 'Settings: Model',
  'palette.settingsCompute': 'Settings: Compute hosts',
  'palette.settingsStorage': 'Settings: Storage',
  'palette.settingsAgent': 'Settings: Agent',
  'palette.keyboardShortcuts': 'Keyboard shortcuts'
}
const translate = (key: TranslationKey): string => LABELS[key] ?? key

const buildContext = (): PaletteCommandContext => ({
  openSettings: vi.fn<() => void>(),
  openSettingsToPanel: vi.fn<(panel: SettingsPanelId) => void>(),
  openSettingsToCompute: vi.fn<() => void>(),
  openKeyboardShortcuts: vi.fn<() => void>()
})

const callCount = (spy: unknown): number => (spy as { mock: { calls: unknown[][] } }).mock.calls.length

const callsOf = (spy: unknown): unknown[][] => (spy as { mock: { calls: unknown[][] } }).mock.calls

describe('palette-commands', () => {
  it('runs something for every command it offers', () => {
    // A command row that does nothing is the failure mode this catalog exists to avoid: every entry is
    // checked against the context it was built from, so an unwired command cannot ship.
    const commands = buildPaletteCommands(buildContext())
    expect(commands.length).toBeGreaterThan(0)
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length)

    for (const command of commands) {
      const context = buildContext()
      const wired = buildPaletteCommands(context).find((entry) => entry.id === command.id)
      expect(wired).toBeDefined()
      wired?.run()
      const total =
        callCount(context.openSettings) +
        callCount(context.openSettingsToPanel) +
        callCount(context.openSettingsToCompute) +
        callCount(context.openKeyboardShortcuts)
      expect(total, `${command.id} must run exactly one action`).toBe(1)
    }
  })

  it('reaches a settings panel through a keyword a user would actually type', () => {
    const commands = buildPaletteCommands(buildContext())
    expect(matchPaletteCommands(commands, 'mirror', translate).map((c) => c.id)).toContain(
      'settings.network'
    )
    expect(matchPaletteCommands(commands, '代理', translate).map((c) => c.id)).toContain(
      'settings.network'
    )
  })

  it('ranks a label hit above a keyword hit', () => {
    const commands = buildPaletteCommands(buildContext())
    // "keyboard" is in the shortcuts label; "chord" is only a keyword of the same command.
    expect(matchPaletteCommands(commands, 'keyboard', translate)[0]?.id).toBe('shortcuts.open')
    expect(matchPaletteCommands(commands, 'chord', translate)[0]?.id).toBe('shortcuts.open')
  })

  it('offers only the top commands before anything is typed, and nothing when nothing matches', () => {
    const commands = buildPaletteCommands(buildContext())
    expect(matchPaletteCommands(commands, '', translate)).toHaveLength(PALETTE_COMMAND_LIMIT)
    expect(matchPaletteCommands(commands, 'zzzz-no-such-command', translate)).toHaveLength(0)
  })

  it('carries the settings targets the palette cannot guess', () => {
    const context = buildContext()
    const commands = buildPaletteCommands(context)

    commands.find((command) => command.id === 'settings.network')?.run()
    expect(callsOf(context.openSettingsToPanel)).toEqual([['network']])

    commands.find((command) => command.id === 'settings.compute')?.run()
    expect(callCount(context.openSettingsToCompute)).toBe(1)

    commands.find((command) => command.id === 'settings.open')?.run()
    expect(callCount(context.openSettings)).toBe(1)
  })
})
