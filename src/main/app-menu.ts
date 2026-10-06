import { Menu, app, dialog, type MenuItemConstructorOptions } from 'electron'

import { appMenuLabelsForLocale, type AppMenuLabels } from '../shared/app-menu-labels'

// Installs a locale-following application menu (roles keep native accelerators/behavior; only the
// visible labels come from the per-locale table). Without this, Electron shows its default
// English menu on every platform regardless of the system language.
//
// Windows and Linux render this menu inside the window — the platform's title-bar application menu.
// macOS has no such bar (it gets About from the application menu), so the Help → About entry exists
// only where nothing else provides one. The template is a pure function of (platform, labels, app
// facts) precisely so each platform's shape can be asserted without a Windows machine — and the
// Windows CI lane then runs those same assertions on real Windows.
export type ApplicationMenuContext = {
  platform: NodeJS.Platform
  labels: AppMenuLabels
  appName: string
  version: string
  onAbout: () => void
}

export const applicationMenuTemplate = (
  context: ApplicationMenuContext
): MenuItemConstructorOptions[] => {
  const { platform, labels: L, appName, onAbout } = context
  const isMac = platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: L.about },
        { type: 'separator' },
        { role: 'services', label: L.services },
        { type: 'separator' },
        { role: 'hide', label: L.hide },
        { role: 'hideOthers', label: L.hideOthers },
        { role: 'unhide', label: L.showAll },
        { type: 'separator' },
        { role: 'quit', label: L.quit }
      ]
    })
  }

  template.push({
    label: L.file,
    submenu: isMac ? [{ role: 'close', label: L.close }] : [{ role: 'quit', label: L.quit }]
  })

  template.push({
    label: L.edit,
    submenu: [
      { role: 'undo', label: L.undo },
      { role: 'redo', label: L.redo },
      { type: 'separator' },
      { role: 'cut', label: L.cut },
      { role: 'copy', label: L.copy },
      { role: 'paste', label: L.paste },
      { role: 'selectAll', label: L.selectAll }
    ]
  })

  template.push({
    label: L.view,
    submenu: [
      { role: 'reload', label: L.reload },
      { role: 'forceReload', label: L.forceReload },
      { role: 'toggleDevTools', label: L.toggleDevTools },
      { type: 'separator' },
      { role: 'resetZoom', label: L.actualSize },
      { role: 'zoomIn', label: L.zoomIn },
      { role: 'zoomOut', label: L.zoomOut },
      { type: 'separator' },
      { role: 'togglefullscreen', label: L.toggleFullScreen }
    ]
  })

  template.push({
    label: L.windowMenu,
    submenu: isMac
      ? [
          { role: 'minimize', label: L.minimize },
          { role: 'zoom', label: L.zoom },
          { type: 'separator' },
          { role: 'front', label: L.front }
        ]
      : [
          { role: 'minimize', label: L.minimize },
          { role: 'close', label: L.close }
        ]
  })

  // Electron's `about` role is macOS-only, so on Windows and Linux it would draw an entry that does
  // nothing at all. The click below is what makes this entry real there.
  if (!isMac) {
    template.push({
      label: L.help,
      submenu: [{ label: L.about, click: () => onAbout() }]
    })
  }

  return template
}

export const installLocalizedApplicationMenu = (): void => {
  const appName = app.name
  const appVersion = app.getVersion()

  const template = applicationMenuTemplate({
    platform: process.platform,
    labels: appMenuLabelsForLocale(app.getLocale()),
    appName,
    version: appVersion,
    onAbout: () => {
      void dialog.showMessageBox({
        type: 'info',
        title: appName,
        message: appName,
        detail: appVersion
      })
    }
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
