import { Menu, app, type MenuItemConstructorOptions } from 'electron'

import { appMenuLabelsForLocale } from '../shared/app-menu-labels'

// Installs a locale-following application menu (roles keep native accelerators/behavior; only the
// visible labels come from the per-locale table). Without this, Electron shows its default
// English menu on every platform regardless of the system language.
export const installLocalizedApplicationMenu = (): void => {
  const L = appMenuLabelsForLocale(app.getLocale())
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
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

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
