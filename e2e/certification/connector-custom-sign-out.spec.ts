import { expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { test } from '../fixtures/electron-app'

// IC21 real-window acceptance: a signed-in user-added server can actually be signed out, and it sticks.
//
// Completing a real OAuth round trip against a stub is not what this unit is about (sign-out is), so the
// signed-in state is seeded the way the app itself stores it: a `plain:` oauthRef (a form main still reads
// for migration) on the server record, followed by a restart so main re-reads the document. The token is
// deliberately fake — the question is whether the window and main can together end a session and stop
// claiming to be connected, not whether a token works.
const TOKEN_STATE = { tokens: { access_token: 'seed-token' } }

test.setTimeout(180_000)

test('signing out of a user-added server clears the session and survives a restart', async ({
  app
}) => {
  const page = await app.completeOnboarding()

  const added = await page.evaluate(async (): Promise<string> => {
    const snapshot = await window.api.settings.addCustomServer({
      name: 'OAuth Probe',
      description: 'OAuth probe server',
      transport: 'streamable_http',
      url: 'https://oauth-probe.test/mcp',
      oauth: {}
    })
    return snapshot.customServers.find((server) => server.name === 'OAuth Probe')?.id ?? ''
  })
  expect(added).not.toBe('')
  console.log(`[ic21] added OAuth server id: ${added}`)

  // Seed the signed-in state (see the note above), then restart so main reads it.
  const settingsPath = join(app.storageRoot, 'settings.json')
  const document = JSON.parse(await readFile(settingsPath, 'utf8')) as {
    connectors?: { customMcpServers?: { id: string; oauthRef?: string }[] }
  }
  const target = document.connectors?.customMcpServers?.find((server) => server.id === added)
  expect(target).toBeTruthy()
  target!.oauthRef = `plain:${Buffer.from(JSON.stringify(TOKEN_STATE)).toString('base64')}`
  await writeFile(settingsPath, JSON.stringify(document, null, 2))

  const reopened = await app.restart()
  await reopened.getByRole('button', { name: 'Settings' }).first().click()
  const settings = reopened.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Connectors' })
    .click()

  // Connected, with the way out on screen.
  await expect(settings.getByRole('button', { name: 'Connected' }).first()).toBeVisible({
    timeout: 60_000
  })
  const signOut = settings.getByRole('button', { name: /Sign out of/ }).first()
  await expect(signOut).toBeVisible()
  const buttonLabel = await settings.getByRole('button', { name: 'Connected' }).first().innerText()
  console.log(
    `[ic21] before: the app itself says "${buttonLabel.trim()}" and offers a Sign out action`
  )

  await signOut.click()

  // Read back through main: the tokens are gone while the server stays an OAuth server (so it can sign in
  // again).
  const after = await reopened.evaluate(
    async (id: string): Promise<{ hasTokens: boolean; isOauth: boolean }> => {
      const snapshot = await window.api.settings.listConnectors()
      const server = snapshot.customServers?.find((entry) => entry.id === id)
      return { hasTokens: Boolean(server?.oauth?.hasTokens), isOauth: Boolean(server?.oauth) }
    },
    added
  )
  console.log(`[ic21] after the click, main reports: ${JSON.stringify(after)}`)
  expect(after.hasTokens).toBe(false)
  expect(after.isOauth).toBe(true)

  // The row flips back to offering sign-in, and the sign-out action is gone.
  await expect(settings.getByRole('button', { name: 'Sign in' }).first()).toBeVisible({
    timeout: 30_000
  })
  await expect(settings.getByRole('button', { name: /Sign out of/ })).toHaveCount(0)
  console.log('[ic21] the row now offers Sign in and no longer offers sign-out')

  // Persistence: a fresh instance must still consider the server signed out.
  const restartedAgain = await app.restart()
  await restartedAgain.getByRole('button', { name: 'Settings' }).first().click()
  const settingsAgain = restartedAgain.getByRole('dialog', { name: 'Settings' })
  await settingsAgain
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Connectors' })
    .click()
  await expect(settingsAgain.getByRole('button', { name: 'Sign in' }).first()).toBeVisible({
    timeout: 60_000
  })
  console.log('[ic21] after a restart the server is still signed out')
})
