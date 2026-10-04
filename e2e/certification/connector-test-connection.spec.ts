import { expect } from '@playwright/test'
import { join } from 'node:path'

import { test } from '../fixtures/electron-app'

// IC23 real-window acceptance: "Test connection" tells "the server answered" apart from "the server did not".
//
// That distinction is the whole reason this action exists: the tool list on the detail page is whatever the
// last read produced, so a server whose process cannot start and a server that genuinely advertises nothing
// render identically. Both cases are exercised here: a real stdio MCP fixture that answers, and a command
// that cannot possibly run.
const fixture = join(__dirname, '..', 'fixtures', 'fake-mcp-probe.mjs')

test.setTimeout(180_000)

test('the connection test reports an answer and a failure differently', async ({ app }) => {
  const page = await app.completeOnboarding()

  const added = await page.evaluate(
    async ([command, args]): Promise<string> => {
      const snapshot = await window.api.settings.addCustomServer({
        name: 'Probe MCP',
        description: 'Probe server fixture',
        transport: 'stdio',
        command,
        args
      })
      return snapshot.customServers.find((server) => server.name === 'Probe MCP')?.id ?? ''
    },
    [process.execPath, [fixture]] as [string, string[]]
  )
  expect(added).not.toBe('')

  const broken = await page.evaluate(async (): Promise<string> => {
    const snapshot = await window.api.settings.addCustomServer({
      name: 'Dead Probe',
      description: 'A command that cannot run',
      transport: 'stdio',
      command: 'this-command-does-not-exist-anywhere'
    })
    return snapshot.customServers.find((server) => server.name === 'Dead Probe')?.id ?? ''
  })
  expect(broken).not.toBe('')

  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Connectors' })
    .click()

  const runTest = async (serverName: string): Promise<{ result: string; text: string }> => {
    await settings
      .getByRole('button', { name: new RegExp(serverName) })
      .first()
      .click()
    const button = settings.getByTestId('connector-test-connection').first()
    await expect(button).toBeVisible({ timeout: 60_000 })
    await expect(button).toBeEnabled()
    await button.click()
    const outcome = settings.getByTestId('connector-test-result').first()
    await expect(outcome).toBeVisible({ timeout: 60_000 })
    const reading = {
      result: (await outcome.getAttribute('data-result')) ?? '',
      text: (await outcome.innerText()).replace(/\s+/g, ' ').trim()
    }
    await settings.getByRole('button', { name: 'Back to connectors' }).first().click()
    return reading
  }

  const alive = await runTest('Probe MCP')
  console.log(`[ic23] the live server: data-result=${alive.result} :: "${alive.text}"`)
  // The fixture advertises exactly two tools, so the count is a fact about the process, not the UI.
  expect(alive.result).toBe('ok')
  expect(alive.text).toContain('2')

  const dead = await runTest('Dead Probe')
  console.log(`[ic23] the unreachable server: data-result=${dead.result} :: "${dead.text}"`)
  // A failure is named as a failure — and it carries the reason, not an empty tool list.
  expect(dead.result).toBe('failed')
  expect(dead.text.length).toBeGreaterThan(0)
  expect(dead.text).not.toBe(alive.text)
})
