import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// The whole-window find bar is an Electron overlay owned by main (resources/find-overlay), not a pane in
// the window's own DOM. That is why the window's contract never calls the six `window.*` find channels —
// the overlay does (and the entry-coverage guard's scan now includes that surface). This drives the
// chord and the overlay in the packaged app; the sibling Windows-only spec in windows-window-system
// covers the same entry on its platform.
test('the find chord opens the whole-window find bar and Escape closes it', async ({ app }) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Window find evidence')

  const modifier = process.platform === 'darwin' ? 'meta' : 'control'

  await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
  await app.pressMainWindowShortcut('F', [modifier])
  await expect.poll(() => app.findOverlayIsVisible()).toBe(true)

  // Escape closes an open bar even when focus sits in the main content, not the find input.
  await app.pressMainWindowShortcut('Escape', [])
  await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
})
