import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import * as tar from 'tar'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

/**
 * The support bundle's trajectory section, read back from the archive the app actually wrote.
 *
 * The section was built and unit-tested (`trajectory/bundle-payload`), and that is exactly the evidence
 * shape this repository does not accept as "delivered": the export path itself — pick the newest session,
 * redact it, checksum the bytes, stage them under `trajectory/`, re-read the archive for leaks — only runs
 * in a real window. The open item in the 2026-10-25 handoff ("trajectory bundle physical export") was
 * blocked on needing the save dialog; the fixture's `stubSaveDialog` is the one seam, so everything
 * downstream of the click is the product's own code.
 *
 * What is asserted, and why each one can only be answered by the real artifact:
 *   1. the section is present and describes the session this test created (not "a session, somehow");
 *   2. `manifest.sections` and the files on disk AGREE — a status that claims `included` while the file is
 *      missing (or the reverse) is the failure mode the named statuses exist to prevent;
 *   3. the message count in the manifest matches the session the app holds, read through the window bridge;
 *   4. every checksum recomputed HERE (node:crypto over the extracted bytes, not the module's own helper)
 *      matches the line the bundle shipped — "another machine holding the bytes can verify it";
 *   5. nothing in `trajectory/` carries the home path, the user name, or a secret-shaped value.
 */

test.setTimeout(240_000)

type Bridge = {
  api: {
    sessions: {
      loadAll: () => Promise<unknown>
    }
  }
}

const listEntries = async (bundlePath: string): Promise<string[]> => {
  const entries: string[] = []
  await tar.list({
    file: bundlePath,
    onReadEntry: (entry) => {
      // Files only: the archive carries directory entries too, and reading one as a file is an error.
      if (entry.type === 'File') entries.push(entry.path.replace(/^\.\//, ''))
    }
  })
  return entries
}

// Which sessions the window holds, by id. Read before prompting so the session this test creates is
// identified by identity rather than by guessing how its title is derived from the prompt.
const listSessionIds = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const bridge = globalThis as unknown as Bridge
    const raw = await bridge.api.sessions.loadAll()
    const list = Array.isArray(raw)
      ? raw
      : ((raw as { sessions?: unknown }).sessions ?? (raw as { items?: unknown }).items)
    const sessions = Array.isArray(list) ? list : []
    return (sessions as Array<Record<string, unknown>>).map((candidate) => String(candidate.id))
  })

type SessionReading = { id: string; messages: number; title: string; artifactIds: number }

// One reading of the sessions the window holds, through the bridge (the app's own read, not a second parse
// of the document on disk). `known` selects the sessions this test did not start with; `only` selects one
// id when the test already knows which session it means.
const readSessionsInWindow = async (
  page: Page,
  selector: { known?: string[]; only?: string }
): Promise<SessionReading[]> =>
  page.evaluate(async (input) => {
    const bridge = globalThis as unknown as Bridge
    const raw = await bridge.api.sessions.loadAll()
    const list = Array.isArray(raw)
      ? raw
      : ((raw as { sessions?: unknown }).sessions ?? (raw as { items?: unknown }).items)
    const sessions = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []
    const wanted = sessions.filter((candidate) => {
      const id = String(candidate.id)
      if (input.only !== undefined) return id === input.only
      return !(input.known ?? []).includes(id)
    })
    return wanted.map((candidate) => {
      const messages = (candidate.messages ?? []) as Array<{ artifactIds?: unknown }>
      // Counted the way the extractor does (distinct, non-empty ids across messages), so the manifest's
      // count can be checked against the window's own reading instead of against the bundle itself.
      const artifactIds = new Set(
        messages.flatMap((message) =>
          Array.isArray(message.artifactIds)
            ? message.artifactIds.filter(
                (id): id is string => typeof id === 'string' && id.trim().length > 0
              )
            : []
        )
      )
      return {
        id: String(candidate.id),
        messages: messages.length,
        title: String(candidate.title ?? ''),
        artifactIds: artifactIds.size
      }
    })
  }, selector)

const readSeededSession = async (page: Page, knownIds: string[]): Promise<SessionReading> => {
  let session: SessionReading | undefined
  await expect
    .poll(
      async () => {
        // The first session this test created that already carries messages; one with none yet is not it.
        session = (await readSessionsInWindow(page, { known: knownIds })).find(
          (candidate) => candidate.messages > 0
        )
        return session
      },
      { timeout: 60_000 }
    )
    .toEqual(expect.objectContaining({ id: expect.any(String) }))
  if (!session) throw new Error('the window never gained a session with messages')
  return session
}

const sha256OfFile = async (path: string): Promise<string> => {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

test('the bundle carries the trajectory section, and its checksums can be recomputed from the archive', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const before = await listSessionIds(page)
  await createProject(page, 'Support bundle trajectory evidence')
  await sendPrompt(page, 'Summarise the docking run.', 'Deterministic reply:', 90_000)
  // A second turn that really produces an artifact: the artifacts section is the one whose design promised
  // "locators only, never an invented checksum", so it is worth reading from a bundle that carries it. If the
  // fixture ends up attaching nothing, the cross-check below still holds at zero on both sides.
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 120_000)
  const seeded = await readSeededSession(page, before)
  console.log(
    `[trajectory-readback] the seeded session: ${seeded.id} (${seeded.messages} messages, title "${seeded.title}")`
  )

  const root = await mkdtemp(join(tmpdir(), 'ps-trajectory-readback-'))
  const bundlePath = join(root, 'support-bundle.tar.gz')
  try {
    await app.stubSaveDialog(bundlePath)

    await page.getByRole('button', { name: 'Settings' }).first().click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: 'General', exact: true })
      .click()
    await settings.getByRole('button', { name: /Export support bundle/i }).click()
    await expect(settings.getByText(/Support bundle saved to/i).first()).toBeVisible({
      timeout: 90_000
    })
    expect((await stat(bundlePath)).size).toBeGreaterThan(0)

    const entries = await listEntries(bundlePath)
    console.log(`[trajectory-readback] the archive carries ${entries.length} files`)
    expect(entries).toEqual(
      expect.arrayContaining([
        'trajectory/manifest.json',
        'trajectory/session.json',
        'trajectory/checksums.sha256'
      ])
    )
    const trajectoryEntries = entries
      .filter((entry) => entry.startsWith('trajectory/'))
      .map((entry) => entry.slice('trajectory/'.length))
      .sort()
    console.log(`[trajectory-readback] trajectory/: ${trajectoryEntries.join(', ')}`)

    const extracted = join(root, 'extracted')
    await mkdir(extracted, { recursive: true })
    await tar.extract({ file: bundlePath, cwd: extracted })
    const sectionDir = join(extracted, 'trajectory')

    // 1. The section describes the session this test created — a bundle about "some session" cannot be
    //    checked against anything, and the newest-session rule is what the export path chooses.
    const manifest = JSON.parse(await readFile(join(sectionDir, 'manifest.json'), 'utf8')) as {
      bundle: string
      sessionId: string
      includeContent: boolean
      sections: Record<string, string>
      counts: { messages: number; toolCalls: number; artifacts: number }
    }
    expect(manifest.bundle).toBe('trajectory/1')
    expect(manifest.sessionId).toBe(seeded.id)
    expect(manifest.includeContent).toBe(true)
    console.log(
      `[trajectory-readback] sections: ${JSON.stringify(manifest.sections)} counts: ${JSON.stringify(manifest.counts)}`
    )

    // 2. Named statuses and file presence must agree, in BOTH directions: an `included` section without
    //    its file is a lie a reader would only discover by opening the archive, and an `absent:` section
    //    that still shipped a file means the reader cannot trust the naming either.
    const fileFor: Record<string, string> = {
      session: 'session.json',
      toolCalls: 'tool-calls.jsonl',
      artifacts: 'artifacts.json',
      capabilities: 'capabilities.json'
    }
    for (const [section, status] of Object.entries(manifest.sections)) {
      const file = fileFor[section]
      expect(file, `unexpected section "${section}" in the manifest`).toBeTruthy()
      const present = trajectoryEntries.includes(file)
      if (status.startsWith('included')) {
        expect(present, `section ${section} says ${status} but ${file} is not in the archive`).toBe(
          true
        )
      } else {
        expect(status).toMatch(/^absent:/)
        expect(present, `section ${section} says ${status} yet ${file} shipped`).toBe(false)
      }
    }

    // 3. The manifest's message count is the session the app holds — read through the window bridge, so it
    //    is the renderer's own reading, not a second parse of the same document. Read HERE, right after the
    //    archive was written, because the archive is a snapshot of that same moment: the last turn's
    //    document lands slightly after its reply is on screen (measured 2026-10-29 on the certification
    //    lane: the earlier reading said 3, the archive said 4, and the archive was the right answer). A
    //    reading taken before the export therefore compares a snapshot with an earlier state; taken at the
    //    snapshot's own moment it means what the sentence says, and a session that really changes under the
    //    export still shows up as a mismatch.
    const held = (await readSessionsInWindow(page, { only: seeded.id }))[0]
    if (!held) throw new Error(`the window no longer holds session ${seeded.id}`)
    console.log(
      `[trajectory-readback] messages: archive ${manifest.counts.messages} / window ${held.messages} ` +
        `(before export the window said ${seeded.messages})`
    )
    expect(manifest.counts.messages).toBe(held.messages)
    // …and the artifact count is the same session's `artifactIds`, counted the way the extractor counts
    // them. Zero on both sides is a real answer here; a manifest that claims more than the session carries
    // would mean the bundle counts something nobody can point at.
    expect(manifest.counts.artifacts).toBe(held.artifactIds)
    if (manifest.sections.artifacts === 'included') {
      const artifacts = JSON.parse(await readFile(join(sectionDir, 'artifacts.json'), 'utf8')) as {
        artifacts: Array<{ artifactVersionId: string }>
      }
      expect(artifacts.artifacts.length).toBe(held.artifactIds)
      for (const artifact of artifacts.artifacts) {
        expect(artifact.artifactVersionId.trim().length).toBeGreaterThan(0)
      }
    }

    // 4. Recompute every checksum here. The recipe is the published one (`<sha256>  <path>`, sorted,
    //    over the bytes that ship), written out independently instead of calling the module that made it:
    //    calling our own helper would only prove it equals itself.
    const checksumLines = (await readFile(join(sectionDir, 'checksums.sha256'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
    const listed = checksumLines.map((line) => line.slice(66))
    expect(listed.slice().sort()).toEqual(
      trajectoryEntries.filter((entry) => entry !== 'checksums.sha256').sort()
    )
    for (const line of checksumLines) {
      const digest = line.slice(0, 64)
      const path = line.slice(66)
      const actual = await sha256OfFile(join(sectionDir, path))
      expect(actual, `trajectory/${path} does not match the checksum the bundle shipped`).toBe(
        digest
      )
    }
    console.log(`[trajectory-readback] ${checksumLines.length} checksums recomputed, all matching`)

    // 5. What ships must not carry the machine it came from, nor a credential-shaped value.
    const home = homedir()
    const userName = userInfo().username
    expect(home).not.toBe('')
    const secretShapes = [/sk-[A-Za-z0-9]{10,}/, /enc:v1:/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
    const files = await readdir(sectionDir)
    for (const file of files) {
      const contents = await readFile(join(sectionDir, file), 'utf8')
      expect(contents, `trajectory/${file} carries the home path`).not.toContain(home)
      expect(contents, `trajectory/${file} carries the user name`).not.toContain(userName)
      for (const shape of secretShapes) {
        expect(shape.test(contents), `trajectory/${file} carries a secret (${String(shape)})`).toBe(
          false
        )
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
