import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

// IC36 real-window acceptance: the session information card names the images this conversation had translated
// by the vision model, and under which extractor generation and evidence schema.
//
// The cache itself is written by the image relay (a text-only backend plus a vision model), which this harness
// cannot drive — so the row is planted with the app's own Prisma client against its own database, in the app's
// own format, and the app is restarted. What is asserted is what the real card renders from a real read: the
// channel, the projection and the section all run for real; only the history is older than the session.
test.setTimeout(180_000)

type VisionEvidenceRow = {
  id: string
  sessionId: string
  projectId: string
}

test('the session info card lists the vision translations behind the conversation', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Vision evidence session')
  await sendPrompt(page, 'Translate the figure in this message.', 'Deterministic reply:')

  // Durable sessions are flushed on the way down, so the session file only exists after a restart. Restart
  // once to get it (and to read the id the row must belong to), then restart again so the card reads a cache
  // that already holds the planted row.
  page = await app.restart()

  const dbPath = join(app.storageRoot, 'purescience.db')
  const prismaModule = (await import('@prisma/client')) as unknown as {
    PrismaClient: new (options: unknown) => {
      session: { findFirst: (args: unknown) => Promise<VisionEvidenceRow | null> }
      visionEvidence: { create: (args: unknown) => Promise<unknown> }
      $disconnect: () => Promise<void>
    }
  }
  const prisma = new prismaModule.PrismaClient({
    datasources: { db: { url: `file:${dbPath}?connection_limit=1` } }
  })

  const evidenceJson = JSON.stringify({ kind: 'figure', summary: 'a line plot of growth curves' })
  const imageChecksum = 'a'.repeat(64)
  const extractorFingerprint = 'b'.repeat(64)
  const imageChecksumPrefix = imageChecksum.slice(0, 12)
  const extractorPrefix = extractorFingerprint.slice(0, 12)

  try {
    // Durable sessions are per-file JSON (`sessions/<projectId>/<id>.json`), not database rows — read the one
    // the app just wrote rather than looking for it in the schema.
    const sessionsRoot = join(app.storageRoot, 'sessions')
    let planted: { id: string; projectId: string } | undefined
    for (const directory of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      const files = await readdir(join(sessionsRoot, directory.name), { withFileTypes: true })
      // `<id>.json` sits beside `<id>.json.summary.json`; the summary is a projection without the document's
      // own id, so it must not be the one that gets read.
      const file = files.find(
        (entry) =>
          entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.summary.json')
      )
      if (!file) continue
      const document = JSON.parse(
        await readFile(join(sessionsRoot, directory.name, file.name), 'utf8')
      ) as { id?: string }
      // The project is carried by the path, not necessarily by the document, and the file name is the id.
      const id = document.id ?? file.name.replace(/\.json$/, '')
      if (id && directory.name) {
        planted = { id, projectId: directory.name }
        break
      }
    }
    expect(planted).toBeDefined()
    const row = planted as { id: string; projectId: string }
    await prisma.visionEvidence.create({
      data: {
        id: createHash('sha256').update(`${imageChecksum}${extractorFingerprint}3`).digest('hex'),
        projectId: row.projectId,
        sessionId: row.id,
        // The schema's own sourceIdentity check: 'message-image' rows must carry both ids and leave the
        // upload-version column null. No foreign keys are declared on them, so shaped ids are enough.
        sourceKind: 'message-image',
        uploadVersionId: null,
        sourceMessageId: 'ic36-message-1',
        sourceImageId: 'ic36-image-1',
        imageChecksum,
        mimeType: 'image/png',
        extractorFingerprint,
        evidenceSchemaVersion: 3,
        evidenceJson,
        evidenceChecksum: createHash('sha256').update(evidenceJson).digest('hex')
      }
    })
    console.log(`[ic36] planted one vision-evidence row for session ${row.id}`)
  } finally {
    await prisma.$disconnect()
  }

  page = await app.restart()
  await openRecentSession(page, 'Translate the figure in this message.')
  // The card's own entry, then the section it now carries.
  await page.getByTestId('conversation-title-button').click()
  const card = page.locator('[data-slot="session-info-card"]')
  await card.waitFor({ state: 'visible', timeout: 60_000 })

  const section = card.locator('[data-slot="session-info-vision-evidence"]')
  await expect(section).toBeVisible({ timeout: 30_000 })
  const item = card.locator('[data-slot="session-info-vision-evidence-item"]').first()
  const text = (await item.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic36] the card says: "${text}"`)
  expect(text).toContain(imageChecksumPrefix)
  expect(text).toContain('image/png')
  expect(text).toContain(extractorPrefix)
  expect(text).toContain('v3')
  // Read-only: a record of what happened, with nothing to press.
  console.log(`[ic36] controls in the entry: ${await item.locator('button, a').count()}`)
  expect(await item.locator('button, a').count()).toBe(0)
})
