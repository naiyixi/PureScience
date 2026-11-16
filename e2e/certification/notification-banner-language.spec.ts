import { readFile } from 'node:fs/promises'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'
import { NATIVE_LOCALE_CODES } from '../../src/main/native-locale'
import { renderTaskNotification } from '../../src/main/notifications/task-notification-strings'

// A task banner is drawn by the OS: there is no window to screenshot and no DOM to read, so the only
// honest reading is what the app itself recorded when it handed the text to the OS. That is the record
// this spec asserts on — first that the delivery happened at all on a real turn, then that the sentence
// it delivered is the one the copy table produces for the language the app reported.
//
// The service suppresses delivery while a window is focused (the reader is already looking at the app),
// so the window is blurred first and the blur is read back: without that read-back a suppressed banner
// and a banner that was never built look exactly alike.

const PROMPT = 'Create a provenance artifact.'
const REPLY = 'Artifact provenance verified for session'

// The app's own log mirror, with ANSI colour codes stripped. One record per line for messages that
// carry no payload; a message with payload continues on the following lines of the same record.
// An escape character cannot be written into a regex literal (lint rejects control characters in one),
// so it is assembled the way the update spec already does.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const logLines = async (path: string): Promise<string[]> =>
  (await readFile(path, 'utf8')).replace(ANSI, '').split('\n')

// Everything from the delivery line up to the next bracketed scope, so a payload spread over a few
// lines is still read as one record.
const deliveryRecord = (lines: readonly string[]): string | undefined => {
  const start = lines.findIndex((line) => line.includes('delivering task notification'))
  if (start === -1) return undefined

  const rest = lines.slice(start)
  const end = rest.findIndex((line, index) => index > 0 && /^\[[a-z]/.test(line))

  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

const field = (record: string, name: string): string | undefined => {
  const match = new RegExp(`${name}:\\s*'([^']*)'`).exec(record)

  return match?.[1]
}

test.setTimeout(240_000)

test('the task banner is drawn in the machine language, not in the English the service carries', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  // Configuring the fake agent restarts the app (the provider only takes effect on a fresh launch), so
  // the page object has to be taken from the restart — the pre-restart one is closed.
  page = await app.configureFakeAgent()
  await createProject(page, 'Banner language')

  // Read back, not assumed: a window that stayed focused would make the banner legitimately suppressed.
  expect(await app.blurMainWindow()).toBe(true)

  const logPath = app.currentLaunchLogPath
  expect(logPath).toBeTruthy()

  await sendPrompt(page, PROMPT, REPLY, 90_000)

  let record: string | undefined
  await expect
    .poll(
      async () => {
        record = deliveryRecord(await logLines(logPath as string))

        return record !== undefined
      },
      { timeout: 30_000 }
    )
    .toBe(true)

  const delivered = record as string
  console.log(`[banner-language] the app's own delivery record: ${delivered}`)

  const language = field(delivered, 'language')
  expect(NATIVE_LOCALE_CODES).toContain(language)

  const code = language as (typeof NATIVE_LOCALE_CODES)[number]
  const expected = renderTaskNotification({ kind: 'task.completed', task: PROMPT }, code)

  // What the OS was asked to draw is the copy table's sentence for that language — not the canonical
  // English the service composes for its log.
  expect(delivered).toContain(`title: '${expected.title}'`)
  expect(field(delivered, 'title')).toBe(expected.title)
  // Both wordings are on one line, which is what makes "wrong language" and "wording drifted"
  // distinguishable after the fact.
  expect(delivered).toContain(
    `canonicalTitle: '${renderTaskNotification({ kind: 'task.completed', task: PROMPT }, 'en').title}'`
  )

  // And the reading that matters for the eight non-English languages: an English table row must not be
  // what a non-English machine draws.
  if (code !== 'en') {
    expect(expected.title).not.toBe(
      renderTaskNotification({ kind: 'task.completed', task: PROMPT }, 'en').title
    )
  }
})
