import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the third bookmark anchor on a real window: a region drawn on a real PDF page becomes a
// bookmark that names the page, the rectangle and the Artifact Version it was drawn on.
//
// The fixture agent writes a one-page PDF through the app's own artifact tool, so the page being drawn on
// is produced and versioned by the product rather than by the test, and the assertion reads the stored
// bookmark back out of the app rather than trusting the UI message alone.

test.setTimeout(180_000)

test('draws a region on a PDF page and keeps it as a bookmark of that version', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'PDF region evidence')
  await sendPrompt(page, 'Create a region drawing PDF.', 'Region PDF ready for session', 90_000)

  const receipt = await page.getByText(/^Region PDF ready for session /).innerText()
  const identity = receipt.match(
    /^Region PDF ready for session ([^,]+), artifact ([^,]+), version ([^.]+)\.$/
  )
  if (!identity) throw new Error(`Invalid PDF artifact receipt: ${receipt}`)
  const [, sessionId] = identity
  // The preview shows the artifact's current Version, which is not necessarily the one the agent just
  // wrote — the app may finalize again before the reader opens it, and the ids in the receipt describe
  // the write rather than the state the reader sees. What has to hold is the reader's guarantee: the
  // region names the version that was on screen, through two identities that agree, and the pointer the
  // jump uses resolves back to that same version.

  // Open the PDF the way a reader does — from the generated-file card in the transcript.
  await page.getByRole('button', { name: 'Preview generated file region-evidence.pdf' }).click()
  const toggle = page.locator('[data-slot="pdf-region-toggle"]')
  await expect(toggle).toBeVisible()
  await toggle.click()

  const overlay = page.locator('[data-slot="pdf-region-overlay"]').first()
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  if (!box) throw new Error('the PDF page offers no box to draw on')

  // Draw the way a hand does: press, move, release.
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 })
  await page.mouse.up()

  await expect(page.getByText('Region saved to bookmarks')).toBeVisible()

  // Read it back out of the app: the anchor must name the page, a real rectangle, and the version on
  // screen — a region that cannot be reopened is not a bookmark.
  const stored = await page.evaluate(async (id) => {
    const bridge = globalThis as unknown as {
      api: {
        bookmark: {
          list: (
            sessionId: string
          ) => Promise<Array<{ anchor: Record<string, unknown>; createdAt?: number }>>
        }
      }
    }
    return bridge.api.bookmark.list(id)
  }, sessionId)

  // The session id is constant across runs and the bookmark file for it is kept, so the region that was
  // just drawn is the newest one — taking the first match would assert against an earlier run's region.
  const regions = stored
    .filter((entry) => entry.anchor.kind === 'pdf-region')
    .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
  const region = regions[0]
  expect(region, 'the drawn region was not stored').toBeTruthy()
  expect(region?.anchor).toMatchObject({ kind: 'pdf-region', page: 1 })
  const rect = region?.anchor.rect as { x: number; y: number; width: number; height: number }
  expect(rect.width).toBeGreaterThan(0.3)
  expect(rect.height).toBeGreaterThan(0.2)

  // The two identities the anchor carries must agree, and must be real: the version id on the evidence
  // trail and the version inside the jump locator are the same one, and that version exists.
  const versionId = String(region?.anchor.artifactVersionId ?? '')
  const locator = String(region?.anchor.locator ?? '')
  expect(versionId).not.toBe('')
  expect(locator).toContain(versionId)

  // Resolve the pointer exactly as the jump does: parse the locator, ask that artifact for its lineage,
  // and require the version it names to be there. A region whose pointer does not resolve would open
  // nothing for the reader, which is why it is the assertion that matters.
  const resolved = await page.evaluate(
    async ({ locator, projectId, sessionId }) => {
      const bridge = globalThis as unknown as {
        api: {
          artifacts: {
            getLineage: (request: {
              projectId: string
              appSessionId: string
              artifactId: string
            }) => Promise<{ versions: Array<{ versionId: string }> } | undefined>
          }
        }
      }
      // The locator is the scheme prefix plus four encoded segments; the prefix is stripped by name so a
      // scheme change cannot silently shift the segments.
      const tail = locator.replace(/^artifact-version:/, '').split('/')
      const identity = {
        projectId: decodeURIComponent(tail[0] ?? ''),
        appSessionId: decodeURIComponent(tail[1] ?? ''),
        artifactId: decodeURIComponent(tail[2] ?? ''),
        versionId: decodeURIComponent(tail[3] ?? '')
      }
      if (!identity.artifactId || !identity.versionId) {
        return {
          identity,
          versions: [] as string[],
          projectIdSent: projectId,
          sessionIdSent: sessionId
        }
      }
      const found = await bridge.api.artifacts.getLineage({
        projectId: identity.projectId,
        appSessionId: identity.appSessionId,
        artifactId: identity.artifactId
      })
      return {
        identity,
        versions: (found?.versions ?? []).map((version) => version.versionId),
        projectIdSent: projectId,
        sessionIdSent: sessionId
      }
    },
    { locator, projectId, sessionId }
  )
  expect(resolved.identity.versionId).toBe(versionId)
  expect(resolved.versions).toContain(versionId)
})
