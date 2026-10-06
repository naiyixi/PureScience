import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

// The template builder is a pure function of (platform, labels, app facts), so every platform's shape
// is asserted here — and because this suite runs on the Windows Full Test lane too, the win32
// expectations below are executed on real Windows, not only simulated.
vi.mock('electron', () => ({
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  app: { name: 'PureScience', getVersion: () => '0.0.0-test', getLocale: () => 'en' },
  dialog: { showMessageBox: vi.fn() }
}))

import { appMenuLabelsForLocale } from '../shared/app-menu-labels'
import { applicationMenuTemplate, type ApplicationMenuContext } from './app-menu'

const EN = appMenuLabelsForLocale('en')
const ZH = appMenuLabelsForLocale('zh')

const contextFor = (platform: NodeJS.Platform): ApplicationMenuContext => ({
  platform,
  labels: EN,
  appName: 'PureScience',
  version: '0.0.0-test',
  onAbout: vi.fn()
})

const submenuOf = (
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] =>
  (template.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[]) ?? []

const rolesIn = (template: MenuItemConstructorOptions[], label: string): unknown[] =>
  submenuOf(template, label).map((item) => item.role)

describe('application menu template', () => {
  it('macOS keeps About in the application menu and adds no Help menu', () => {
    const template = applicationMenuTemplate(contextFor('darwin'))

    expect(template[0]?.label).toBe('PureScience')
    expect(submenuOf(template, 'PureScience').map((item) => item.role)).toContain('about')
    // Help exists only where nothing else provides About.
    expect(template.map((item) => item.label)).not.toContain(EN.help)
    expect(rolesIn(template, EN.file)).toEqual(['close'])
  })

  it.each(['win32', 'linux'])(
    '%s gets a title-bar menu whose Help -> About entry really acts',
    (platform) => {
      const context = contextFor(platform as NodeJS.Platform)
      const template = applicationMenuTemplate(context)

      // No macOS-style application menu: the first entry is File.
      expect(template[0]?.label).toBe(EN.file)
      expect(rolesIn(template, EN.file)).toEqual(['quit'])

      const help = template.find((item) => item.label === EN.help)
      expect(help).toBeDefined()
      const about = submenuOf(template, EN.help)[0]
      expect(about?.label).toBe(EN.about)
      // Electron's `about` role is macOS-only — an entry relying on it would do nothing here.
      expect(about?.role).toBeUndefined()
      expect(typeof about?.click).toBe('function')

      ;(about?.click as () => void)()
      expect(context.onAbout).toHaveBeenCalledTimes(1)

      expect(rolesIn(template, EN.windowMenu)).toEqual(['minimize', 'close'])
    }
  )

  it('uses the labels it is handed rather than a hard-coded locale', () => {
    const template = applicationMenuTemplate({ ...contextFor('win32'), labels: ZH })

    expect(template.map((item) => item.label)).toContain(ZH.help)
    expect(template.map((item) => item.label)).not.toContain(EN.help)
  })
})
