import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// Acceptance for choosing a notebook runtime in Settings, on a real window with the real IPC surface.
//
// The panel could register an interpreter, enable it and read its packages, but it had no control for
// the ONE decision the runtime registry exists for: which interpreter this language actually runs on.
// runtime:set-selection and runtime:unregister-interpreter had no renderer caller at all, so a
// registered interpreter was permanent and the persisted selection was invisible.
//
// The registration itself goes through the API here because the picker is a native file dialog that
// Playwright cannot drive; everything the user decides through the UI is done through the panel's own
// controls.

// A venv's interpreter lives outside every location the system scan reads (PATH, the standard bin
// dirs, framework and conda roots), so the Settings catalog is the only source that knows it — which is
// what makes unregistering it observably remove it. Registering a Homebrew python instead proves
// nothing: the scan finds that same path on its own.
const SYSTEM_PYTHON = '/opt/homebrew/bin/python3'

type RuntimeApi = {
  runtime: {
    listEnvironments: () => Promise<{
      python: Array<{
        interpreterPath: string
        label: string
        runnable: boolean
        registration?: string
      }>
    }>
    registerInterpreter: (language: string, path: string) => Promise<unknown>
    survey: () => Promise<
      Array<{
        language: string
        selection: { source: string; interpreterPath?: string } | undefined
        external: { selected: boolean; interpreterPath?: string }
      }>
    >
  }
}

const openRuntimes = async (page: Page): Promise<ReturnType<Page['getByRole']>> => {
  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Runtimes' })
    .click()

  return settings
}

test('the panel chooses a notebook interpreter and can take it back out', async ({ app }) => {
  const scratch = mkdtempSync(join(tmpdir(), 'u10-runtime-'))
  const INTERPRETER = join(scratch, 'venv', 'bin', 'python3')
  // --copies matters: a default venv symlinks its interpreter, and the app identifies interpreters by
  // real path, so a symlinked venv collapses into the Homebrew install the scan already found.
  execFileSync('python3', ['-m', 'venv', '--copies', join(scratch, 'venv')])

  const page = await app.completeOnboarding()

  const registered = await page.evaluate(async (path) => {
    const { api } = globalThis as unknown as { api: RuntimeApi }
    await api.runtime.registerInterpreter('python', path)
    const environments = await api.runtime.listEnvironments()

    return environments.python.find((env) => env.interpreterPath === path) ?? null
  }, INTERPRETER)
  expect(registered?.runnable).toBe(true)
  const registration = await page.evaluate(async (path) => {
    const { api } = globalThis as unknown as { api: RuntimeApi }
    const environments = await api.runtime.listEnvironments()

    return (environments.python ?? []).find((env) => env.interpreterPath === path)?.registration
  }, INTERPRETER)
  expect(registration).toBe('catalog')

  let settings = await openRuntimes(page)
  const card = (): ReturnType<Page['locator']> =>
    settings.locator('[data-testid="runtime-card"]', { hasText: INTERPRETER }).first()

  await expect(card()).toBeVisible()
  // A user's own interpreter defaults to disabled, and a disabled runtime is one the agent never sees,
  // so it must be enabled before it can be promoted.
  await card().getByLabel(`Enable ${registered?.label}`).click()
  await card().getByTestId('runtime-use-for-notebooks').click()
  await expect(settings.getByTestId('runtimes-notice')).toContainText(`Notebooks will use`)
  await expect(card().getByTestId('runtime-current')).toBeVisible()

  // The other side of the story is the persisted selection: what the notebook binding resolves from.
  const selection = await page.evaluate(async () => {
    const { api } = globalThis as unknown as { api: RuntimeApi }
    const survey = await api.runtime.survey()
    const python = survey.find((entry) => entry.language === 'python')

    return {
      source: python?.selection?.source,
      interpreterPath: python?.selection?.interpreterPath,
      selectedInSurvey: python?.external.selected,
      surveyPath: python?.external.interpreterPath
    }
  })
  expect(selection).toEqual({
    source: 'external',
    interpreterPath: INTERPRETER,
    selectedInSurvey: true,
    surveyPath: INTERPRETER
  })

  // It survives a fresh load of the panel, rather than only living in the render that set it.
  await settings.getByRole('button', { name: 'Close settings' }).click()
  settings = await openRuntimes(page)
  await expect(card().getByTestId('runtime-current')).toBeVisible()

  // The honest gate: an interpreter the scan finds by itself offers no unregister control, because
  // clicking it would remove nothing while looking like it did.
  const systemCard = settings
    .locator('[data-testid="runtime-card"]', { hasText: SYSTEM_PYTHON })
    .first()
  if ((await systemCard.count()) > 0) {
    await expect(systemCard.getByTestId('runtime-unregister')).toHaveCount(0)
  }

  // Unregistering takes it back out of the candidate list for good.
  await card().getByTestId('runtime-unregister').click()
  await expect(settings.getByTestId('runtimes-notice')).toContainText('Unregistered')
  await expect(card()).toHaveCount(0)
  const remaining = await page.evaluate(async (path) => {
    const { api } = globalThis as unknown as { api: RuntimeApi }
    const environments = await api.runtime.listEnvironments()

    return environments.python.some((env) => env.interpreterPath === path)
  }, INTERPRETER)
  expect(remaining).toBe(false)

  rmSync(scratch, { recursive: true, force: true })
})
