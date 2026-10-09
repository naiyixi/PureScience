import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

test.setTimeout(180_000)

test('retains an Artifact Version producer across Electron relaunch', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Artifact provenance evidence')
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )

  const receipt = await page.getByText(/^Artifact provenance verified for session /).innerText()
  const identity = receipt.match(
    /^Artifact provenance verified for session ([^,]+), artifact ([^,]+), version ([^.]+)\.$/
  )
  if (!identity) throw new Error(`Invalid Artifact provenance receipt: ${receipt}`)
  const [, appSessionId, artifactId, versionId] = identity

  const readProvenance = (): Promise<unknown> =>
    page.evaluate(
      async ({ appSessionId, artifactId, projectId, versionId }) => {
        const bridge = globalThis as unknown as {
          api: {
            artifacts: {
              getVersionProvenance: (request: {
                projectId: string
                appSessionId: string
                artifactId: string
                versionId: string
              }) => Promise<unknown>
            }
          }
        }
        return bridge.api.artifacts.getVersionProvenance({
          projectId,
          appSessionId,
          artifactId,
          versionId
        })
      },
      { appSessionId: appSessionId!, artifactId: artifactId!, projectId, versionId: versionId! }
    )

  await expect.poll(readProvenance, { timeout: 30_000 }).toMatchObject({
    contentStatus: { state: 'available' },
    evidence: {
      producer: {
        state: 'available',
        producer_run_id: expect.any(String)
      }
    }
  })

  page = await app.restart()
  await expect.poll(readProvenance, { timeout: 30_000 }).toMatchObject({
    contentStatus: { state: 'available' }
  })
})

test('the provenance panel shows what the session read, recipe and window included', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Artifact readings evidence')
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )

  const receipt = await page.getByText(/^Artifact provenance verified for session /).innerText()
  const identity = receipt.match(
    /^Artifact provenance verified for session ([^,]+), artifact ([^,]+), version ([^.]+)\.$/
  )
  if (!identity) throw new Error(`Invalid Artifact provenance receipt: ${receipt}`)
  const [, appSessionId, artifactId] = identity

  // The journal is seeded at the exact path the app's own write path uses
  // (`<storage root>/.connector-readings/<sessionId>.json`), so this reading covers the display half on
  // a real window: the projection resolves the journal beside the data root and the panel renders it.
  // The write half — a journal entry produced by a real connector call — is the recording path's own
  // evidence (a live probe against the real service, recorded in the evidence note), not this spec.
  const digest = `sha256:${'5'.repeat(64)}`
  // The journal lives beside the app's DATA root, which is NOT the root the harness hands out:
  // `PURESCIENCE_E2E_STORAGE_ROOT` pins the config root, and the data root is derived from it by the
  // app's own rules (`<root>/PureScience-DEV` unpackaged, `<root>/PureScience` packaged). The main
  // process writes the journal with `recordSessionReadings(resolveDataRoot(), …)`, so the seed has to
  // land on the same root the reading side resolves. Ask the app for the root it actually resolved
  // instead of hardcoding the folder name, so this seed is right in both the local unpackaged run and
  // the packaged certification lane.
  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot
  })
  console.log(`[readings] dataRoot under test: ${dataRoot}`)
  const recordingsDir = join(dataRoot, '.connector-readings')
  await mkdir(recordingsDir, { recursive: true })
  await writeFile(
    join(recordingsDir, `${appSessionId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: appSessionId,
      dropped: 2,
      entries: [
        {
          recordedAt: new Date().toISOString(),
          reading: {
            service: 'pubmed',
            tool: 'search_articles',
            request: {
              method: 'GET',
              url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?term=aspirin'
            },
            response: { status: 200, bytes: 1118, sha256: digest }
          }
        }
      ]
    }),
    'utf8'
  )

  await page
    .getByRole('button', { name: /^Preview generated file provenance-evidence\.txt$/ })
    .first()
    .click()
  await expect(page.getByTestId('preview-card')).toBeVisible()
  await page
    .getByRole('button', { name: /^File actions for / })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Provenance' }).click()
  await expect(page.getByTestId('artifact-provenance')).toBeVisible()

  await page.getByRole('tab', { name: 'Readings' }).click()
  const entry = page.getByTestId('artifact-readings-item').first()
  await expect(entry).toBeVisible()
  console.log(`[readings] entry on screen: ${JSON.stringify(await entry.innerText())}`)
  await expect(entry).toContainText('pubmed · search_articles')
  await expect(entry).toContainText(digest)
  await expect(page.getByTestId('artifact-readings-recipe')).toContainText(
    'purescience-connector-reading-v1'
  )
  await expect(page.getByTestId('artifact-readings-dropped')).toContainText('2 older readings')
  console.log(
    `[readings] recipe line: ${await page.getByTestId('artifact-readings-recipe').innerText()}`
  )
  console.log(`[readings] version under test: ${artifactId}`)
})
