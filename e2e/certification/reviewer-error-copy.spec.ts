import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { normalizeSessionFile } from '../../src/shared/session-persistence'
import { test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

// Real-window acceptance for the review card's error surface.
//
// A failed review used to open straight onto whatever the failing layer wrote. In the field that was a
// framework dump naming a path inside the packaged bundle and quoting the statement that expired — the
// installed app's own Review rows carry exactly the message planted below. This spec runs the real card
// in a real window: the row is planted with the app's own Prisma client against its own database (the
// reviewer cannot be made to fail on demand in a harness), then the app is restarted and the card is read.
test.setTimeout(180_000)

// Verbatim from the installed app's `Review` table (lifecycle='error').
const FIELD_ERROR =
  'Invalid `tx.review.update()` invocation in\n' +
  '/Applications/PureScience.app/Contents/Resources/app.asar/out/main/ipc-CLnmvMls.js:2029:23\n' +
  '\n' +
  '  2026 for (const sourceReviewId of touchedSourceReviewIds) {\n' +
  '  2027   await touchReview(tx, sourceReviewId);\n' +
  '  2028 }\n' +
  '  → 2029 await tx.review.update(\n' +
  'Transaction API error: Transaction already closed: A query cannot be executed on an expired ' +
  'transaction. The timeout for this transaction was 5000 ms, however 6692 ms passed since the start ' +
  'of the transaction.'

type PlantedRow = { projectId: string; sessionId: string; turnMessageId: string }

const readLatestTurn = async (storageRoot: string): Promise<PlantedRow | undefined> => {
  const sessionsRoot = join(storageRoot, 'sessions')
  const files: string[] = []
  for (const directory of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    for (const entry of await readdir(join(sessionsRoot, directory.name), {
      withFileTypes: true
    })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      // `<id>.json` sits beside `<id>.json.summary.json`; the summary has no messages.
      if (entry.name.endsWith('.summary.json')) continue
      files.push(join(sessionsRoot, directory.name, entry.name))
    }
  }
  console.log(`[review-error] session documents on disk: ${files.length}`)
  for (const file of files) {
    // Read through the app's own reader: the file stores the conversation graph, and `messages` is a
    // projection the reader rebuilds. Reimplementing that here would be a second, drifting definition.
    const session = normalizeSessionFile(JSON.parse(await readFile(file, 'utf8')))
    const messages = session?.messages ?? []
    console.log(
      `[review-error] ${file}: session=${session?.id ?? 'none'} messages=${messages.length} ` +
        `roles=${[...new Set(messages.map((message) => message.role))].join(',')}`
    )
    const turnMessageId = [...messages]
      .reverse()
      .find((message) => message.role === 'agent' && message.id)?.id
    if (session?.id && session.projectId && turnMessageId) {
      return { projectId: session.projectId, sessionId: session.id, turnMessageId }
    }
  }
  return undefined
}

test('an error review says what happened in words and keeps the raw output as evidence', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Review error copy')
  await sendPrompt(page, 'Check the calibration table.', 'Deterministic reply:')

  // Durable sessions are flushed on the way down, so the turn id the review must belong to only exists
  // after a restart. Plant the row, then restart again so the card reads it from a real load.
  page = await app.restart()

  const planted = await readLatestTurn(app.storageRoot)
  expect(planted).toBeDefined()
  const row = planted as PlantedRow

  const prismaModule = (await import('@prisma/client')) as unknown as {
    PrismaClient: new (options: unknown) => {
      review: { create: (args: unknown) => Promise<unknown> }
      $disconnect: () => Promise<void>
    }
  }
  const prisma = new prismaModule.PrismaClient({
    datasources: {
      db: { url: `file:${join(app.storageRoot, 'purescience.db')}?connection_limit=1` }
    }
  })
  try {
    await prisma.review.create({
      data: {
        projectId: row.projectId,
        sessionId: row.sessionId,
        turnMessageId: row.turnMessageId,
        scope: JSON.stringify({
          turnMessageId: row.turnMessageId,
          blocks: [],
          artifactVersionIds: []
        }),
        lifecycle: 'error',
        outcome: null,
        errorMessage: FIELD_ERROR,
        model: 'deepseek-v4-flash',
        reviewerLog: '[]'
      }
    })
    console.log(`[review-error] planted an error review on turn ${row.turnMessageId}`)
  } finally {
    await prisma.$disconnect()
  }

  page = await app.restart()
  await openRecentSession(page, 'Check the calibration table.')

  const card = page.getByTestId('reviewer-card')
  await expect(card).toBeVisible({ timeout: 60_000 })

  // Collapsed: the line names the kind of failure, and no framework output is in it.
  const summary = (await card.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[review-error] collapsed card says: "${summary}"`)
  expect(summary).toContain('Review error · verdict not saved')
  expect(summary).not.toContain('Invalid `tx.')

  // Expanded: a sentence a reader can act on, then the raw output under its own label.
  await card.getByRole('button').first().click()
  const plain = card.getByTestId('reviewer-error-plain')
  await expect(plain).toBeVisible()
  const plainText = (await plain.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[review-error] plain sentence: "${plainText}"`)
  expect(plainText).toContain('could not be saved to this project')

  const detail = card.getByTestId('reviewer-error-detail')
  await expect(detail).toBeVisible()
  const detailText = await detail.innerText()
  console.log(`[review-error] technical block keeps the raw message: ${detailText.length} chars`)
  // The label is styled uppercase; match case-insensitively rather than pinning the transform.
  expect(detailText).toMatch(/technical details/i)
  expect(detailText).toContain('Transaction already closed')
})
