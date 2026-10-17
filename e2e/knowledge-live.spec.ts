import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

// The one thing neither the unit tests nor the integration test can assert: a REAL model, in a REAL app
// session, deciding to call knowledge_search. Everything else here is the shipped path — the same MCP server,
// the same RPC server, the same store.
const NOTE = 'TP53 amplification was observed in 12 of 40 samples'

// The digest of the cited line, computed here in the test process — the same bytes the store hashed.
const citedDigest = (): string => createHash('sha256').update(NOTE, 'utf8').digest('hex')

test('a real model session calls knowledge_search', async ({ app }) => {
  // This one needs a real, working credential and downloads the app's own OpenCode adapter, so it skips unless
  // the three variables below are set. It is the only test in the repo that spends someone's tokens, which is
  // why it is opt-in by environment rather than part of the suite:
  //   KB_E2E_KEY=… KB_E2E_BASE=https://…/v1 KB_E2E_MODEL=… npx playwright test e2e/knowledge-live.spec.ts
  test.skip(
    !process.env.KB_E2E_KEY || !process.env.KB_E2E_BASE || !process.env.KB_E2E_MODEL,
    'Set KB_E2E_KEY / KB_E2E_BASE / KB_E2E_MODEL to run a real model session.'
  )
  test.setTimeout(720_000)
  let page = await app.completeOnboarding()

  // 1. A source inside the data root (the store refuses anything outside its managed roots — which is exactly
  //    what it did on the first run of this script, so the path is read from the app instead of guessed).
  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    const info = await bridge.api.storage.getInfo()
    return info.dataRoot
  })
  console.log('DATA_ROOT=' + dataRoot)
  const knowledgeDir = join(dataRoot, 'knowledge-notes')
  await mkdir(knowledgeDir, { recursive: true })
  const notePath = join(knowledgeDir, 'cohort.md')
  await writeFile(notePath, `# Cohort\n${NOTE}\nEGFR remained wild type\n`, 'utf8')

  // 2. A real backend. This machine has no `codex`/`opencode` on PATH and its Codex credential is rejected, so
  //    the app installs its own OpenCode adapter and a custom OpenAI-compatible provider is pointed at the one
  //    credential that does work here. The key comes from the environment, never from this file.
  const key = process.env.KB_E2E_KEY
  const baseUrl = process.env.KB_E2E_BASE
  const model = process.env.KB_E2E_MODEL
  if (!key || !baseUrl || !model)
    throw new Error('KB_E2E_KEY / KB_E2E_BASE / KB_E2E_MODEL must be set.')
  const setup = await page.evaluate(
    async ({ key: apiKey, baseUrl: endpoint, model: modelId }) => {
      const bridge = globalThis as unknown as {
        api: {
          settings: {
            detectOpencode: () => Promise<{ opencodeManaged?: boolean }>
            installOpencode: (request: unknown) => Promise<unknown>
            upsertProvider: (request: unknown) => Promise<{
              providers: {
                id: string
                type: string
                name: string
                models?: string[]
                model?: string
              }[]
            }>
            setActiveProvider: (request: { id: string; model: string }) => Promise<unknown>
            setAgentFramework: (request: { id: string }) => Promise<unknown>
            setDefaultPermissionProfile: (request: { profile: string }) => Promise<unknown>
          }
        }
      }
      const detected = await bridge.api.settings.detectOpencode()
      const installed = detected.opencodeManaged
        ? { skipped: true }
        : await bridge.api.settings.installOpencode({ source: 'managed' })
      const snapshot = await bridge.api.settings.upsertProvider({
        type: 'custom',
        name: 'Knowledge live check provider',
        apiEndpoints: ['openai'],
        baseUrl: endpoint,
        model: modelId,
        key: apiKey
      })
      const provider = snapshot.providers.find(
        (entry) => entry.name === 'Knowledge live check provider'
      )
      if (!provider) throw new Error('The live-check provider was not persisted.')
      await bridge.api.settings.setActiveProvider({ id: provider.id, model: modelId })
      await bridge.api.settings.setAgentFramework({ id: 'opencode' })
      // 'full' so a tool call does not wait on a permission prompt nobody is here to click.
      await bridge.api.settings.setDefaultPermissionProfile({ profile: 'full' })
      return { installed, id: provider.id, model: modelId }
    },
    { key, baseUrl, model }
  )
  console.log('SETUP=' + JSON.stringify(setup))
  expect(setup).toBeTruthy()

  page = await app.restart()

  // 3. A project, then one message that only succeeds if the model really uses the tools.
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Knowledge live check')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  // Deliberately free of the tool names: the model has to pick them from the knowledge server's descriptions.
  // A prompt that spelled them out would let the assertion below match its own text instead of a real call.
  const prompt =
    `This session has a knowledge store. Register the file ${notePath} as a source, and also register the ` +
    `folder it sits in. Then search the store for TP53 and tell me the sha256 the search returned and the ` +
    `exact line it cited. Finally render that folder as a wiki and tell me how many files it lists.`
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  // The proof is the tool call itself: the model has to choose knowledge_register_source, then knowledge_search,
  // and the search has to come back with the citation. Waiting on the tool name (not on prose) keeps this
  // honest — a reply that merely claims to have searched does not satisfy it.
  const toolRun = conversation.getByRole('button', { name: /Ran \d+ tools?/ })
  await expect(toolRun.first()).toBeVisible({ timeout: 300_000 })
  // Both tools, by their own rows: the register call proves the model found the registration surface, the
  // search call proves it then asked the store a question instead of reading the file by other means.
  await expect(
    conversation.getByRole('button', { name: /knowledge_register_source/i }).first()
  ).toBeVisible({ timeout: 60_000 })
  await expect(conversation.getByRole('button', { name: /knowledge_search/i }).first()).toBeVisible(
    { timeout: 60_000 }
  )

  const transcript = await conversation.innerText()
  console.log('TRANSCRIPT_LEN=' + transcript.length)
  console.log('TRANSCRIPT=' + transcript.replace(/\n+/g, ' | ').slice(0, 3000))

  // Read the tool's OWN output rather than the model's prose: the citation is what the store returned, and a
  // reply cannot fabricate it. The digest below is computed here from the line on disk.
  await conversation
    .getByRole('button', { name: /knowledge_search/i })
    .first()
    .click()
  const expanded = await conversation.innerText()
  console.log('EXPANDED=' + expanded.replace(/\n+/g, ' | ').slice(0, 3000))
  expect(expanded.replace(/\s+/g, '')).toContain(citedDigest())

  // The fourth tool, same session: the model has to notice the folder registration and then render it. The
  // document's rows carry digests of the files as they are now, so this is not a prose claim either.
  const wikiTool = conversation.getByRole('button', { name: /knowledge_render_wiki/i }).first()
  await expect(wikiTool).toBeVisible({ timeout: 180_000 })
  await wikiTool.click()
  const wikiText = await conversation.innerText()
  console.log('WIKI=' + wikiText.replace(/\n+/g, ' | ').slice(-1500))
  expect(wikiText.replace(/\s+/g, '')).toContain('written')
})
