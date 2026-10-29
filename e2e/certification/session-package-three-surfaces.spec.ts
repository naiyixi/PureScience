import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { expect } from '@playwright/test'
import { unzipSync, strFromU8 } from 'fflate'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// Acceptance for D1: the portable-session package leaves the app by THREE roads — the window's own IPC
// channel, the local Web route a phone/bookmark reaches, and the `purescience package` verb — and every
// road must produce the same package for the same session.
//
// What is compared, and why it is compared this way: the archive is byte-reproducible by construction
// (fixed entry timestamps, see session-package/export.ts), so the PAYLOAD is expected to be identical
// byte for byte. The one field that legitimately differs is the manifest's `exportedAt` — these three
// exports really did happen at different moments, and pretending otherwise would mean forging the
// provenance stamp. So the reading is: every entry identical except that single field, whose two values
// are reported rather than ignored.

const execFileAsync = promisify(execFile)
const APP_ROOT = resolve(process.cwd())
const USER_MESSAGE = 'Summarize the deterministic fixture.'
const AGENT_REPLY = `Deterministic reply: ${USER_MESSAGE}`
const PROJECT_NAME = 'Package three surfaces'

type PackageApi = {
  sessions: {
    loadAll: () => Promise<unknown>
    exportPackage: (request: {
      projectId: string
      sessionId: string
      mode: 'essential' | 'full'
      destinationPath?: string
    }) => Promise<{ ok: true; path: string; bytes: number } | { ok: false; error: string }>
  }
  projects: { list: () => Promise<Array<{ id: string; name: string }>> }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const entryDigests = (archive: Uint8Array): Record<string, string> => {
  const entries = unzipSync(archive)
  const digests: Record<string, string> = {}
  for (const [path, contents] of Object.entries(entries)) digests[path] = sha256(contents)
  return digests
}

// The manifest with its provenance stamp removed: everything else in it is a fact about the package and
// must agree across the three roads.
const manifestParts = (
  archive: Uint8Array
): { manifest: string; exportedAt: string | undefined } => {
  const parsed = JSON.parse(strFromU8(unzipSync(archive)['manifest.json']!)) as {
    exportedAt?: string
  }
  const stamp = parsed.exportedAt
  delete parsed.exportedAt
  return { manifest: JSON.stringify(parsed), exportedAt: stamp }
}

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

test('one session, three roads, the same package', async ({ app }) => {
  test.setTimeout(300_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

  const work = await app.createTestDirectory('d1-package')

  // The session must stop changing before three packages of it can be compared: the app reviews a
  // finished turn on its own, so a review (and its findings) can land a second or two after the reply.
  // This exports repeatedly through the window's channel until two consecutive archives carry the same
  // evidence, and only then compares the three roads.
  const probePath = join(work, 'quiescence.science')
  const probeExport = async (): Promise<Record<string, string> | null> => {
    const attempt = await page.evaluate(
      async ({ message, destinationPath }) => {
        const { api } = globalThis as unknown as { api: PackageApi }
        const raw = await api.sessions.loadAll()
        const sessions = (
          Array.isArray(raw) ? raw : ((raw as { sessions?: unknown[] }).sessions ?? [])
        ) as Array<{ id: string; title?: string; projectId?: string }>
        const session = sessions.find((candidate) => (candidate.title ?? '').includes(message))
        if (!session) return { found: false as const }
        return {
          found: true as const,
          projectId: session.projectId ?? '',
          sessionId: session.id,
          result: await api.sessions.exportPackage({
            projectId: session.projectId ?? '',
            sessionId: session.id,
            mode: 'full',
            destinationPath
          })
        }
      },
      { message: USER_MESSAGE, destinationPath: probePath }
    )
    if (!attempt.found || !attempt.result.ok) return null
    const entries = entryDigests(new Uint8Array(await readFile(probePath)))
    delete entries['manifest.json']
    return entries
  }
  let previousEvidence = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const entries = await probeExport()
    if (!entries)
      throw new Error('the session could not be exported while waiting for it to settle')
    const digest = JSON.stringify(entries)
    if (digest === previousEvidence) break
    previousEvidence = digest
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }

  // ---- road 1: the window's own channel (what the export dialog calls) -------------------------------
  const desktopPath = join(work, 'desktop.science')
  const desktopStarted = Date.now()
  const desktop = await page.evaluate(
    async ({ message, destinationPath }) => {
      const { api } = globalThis as unknown as { api: PackageApi }
      const raw = await api.sessions.loadAll()
      const sessions = (
        Array.isArray(raw) ? raw : ((raw as { sessions?: unknown[] }).sessions ?? [])
      ) as Array<{ id: string; title?: string; projectId?: string }>
      const session = sessions.find((candidate) => (candidate.title ?? '').includes(message))
      if (!session) return { found: false as const }
      const projects = await api.projects.list()
      return {
        found: true as const,
        projectId: session.projectId ?? projects[0]?.id ?? '',
        sessionId: session.id,
        result: await api.sessions.exportPackage({
          projectId: session.projectId ?? projects[0]?.id ?? '',
          sessionId: session.id,
          mode: 'full',
          destinationPath
        })
      }
    },
    { message: USER_MESSAGE, destinationPath: desktopPath }
  )
  const desktopMs = Date.now() - desktopStarted
  expect(desktop.found).toBe(true)
  if (!desktop.found) throw new Error('the session the UI just produced was not in the catalog')
  expect(desktop.result.ok, JSON.stringify(desktop.result)).toBe(true)

  // ---- the other two roads need the app's own web service ------------------------------------------
  // A second launch carrying --serve is routed by the running instance into starting its web service
  // (attached), which is exactly the path `purescience start` uses for an app that is already open.
  const electronBinary =
    process.env.PURESCIENCE_E2E_EXECUTABLE ??
    ((await import('electron')) as unknown as { default: string }).default
  const userDataRoot = join(dirname(app.storageRoot), 'electron-profile')
  const port = 52_000 + Math.floor(Math.random() * 900)
  await execFileAsync(
    electronBinary,
    [APP_ROOT, '--lang=en-US', `--user-data-dir=${userDataRoot}`, `--serve=${port}`],
    { cwd: APP_ROOT, timeout: 60_000 }
  )

  const statePath = join(app.storageRoot, 'web-service.json')
  let token = ''
  for (let attempt = 0; attempt < 120 && !token; attempt += 1) {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as { port?: number }
      if (state.port) token = (await readFile(join(app.storageRoot, 'web-token'), 'utf8')).trim()
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
  expect(token, 'the web service never wrote its state').not.toBe('')

  // ---- road 2: the Web route a paired browser or a bookmark reaches --------------------------------
  const webStarted = Date.now()
  const webResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/sessions/${encodeURIComponent(desktop.sessionId)}/package?mode=full&projectId=${encodeURIComponent(desktop.projectId)}`,
    { headers: { authorization: `Bearer ${token}` } }
  )
  const webMs = Date.now() - webStarted
  expect(webResponse.status).toBe(200)
  const webBytes = new Uint8Array(await webResponse.arrayBuffer())
  const webPath = join(work, 'web.science')
  await writeFile(webPath, webBytes)

  // ---- road 3: the command line, against the same running service ---------------------------------
  const cliPath = join(work, 'cli.science')
  const cliStarted = Date.now()
  const { stdout: cliStdout } = await execFileAsync(
    process.execPath,
    [
      join(APP_ROOT, 'packages', 'purescience', 'cli.mjs'),
      'package',
      'export',
      desktop.sessionId,
      '--out',
      cliPath,
      '--mode',
      'full',
      '--config-root',
      app.storageRoot,
      '--json'
    ],
    { cwd: APP_ROOT, timeout: 120_000 }
  )
  const cliMs = Date.now() - cliStarted
  const cliReport = JSON.parse(cliStdout) as { bytes: number; sha256: string; mode: string }

  // ---- the comparison -----------------------------------------------------------------------------
  const desktopBytes = new Uint8Array(await readFile(desktopPath))
  const cliBytes = new Uint8Array(await readFile(cliPath))
  // No whole-file length/SHA equality is asserted: the archives carry a real `exportedAt` stamp, so the
  // compressed size of that one entry can differ by a byte and the container digest with it. What must
  // agree is the package's content, entry by entry — below.
  expect(cliReport.sha256).toBe(sha256(cliBytes))

  // The payload is every entry except the manifest; the manifest's stamp is reported separately below.
  const payloadDigest = (entries: Record<string, string>): string =>
    sha256(
      new TextEncoder().encode(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(entries)
              .filter(([path]) => path !== 'manifest.json')
              .sort(([left], [right]) => left.localeCompare(right))
          )
        )
      )
    )
  const desktopEntries = entryDigests(desktopBytes)
  const webEntries = entryDigests(webBytes)
  const cliEntries = entryDigests(cliBytes)
  expect(payloadDigest(webEntries)).toBe(payloadDigest(desktopEntries))
  expect(payloadDigest(cliEntries)).toBe(payloadDigest(desktopEntries))
  // Every payload entry is byte-identical on all three roads.
  for (const path of Object.keys(desktopEntries).filter((entry) => entry !== 'manifest.json')) {
    expect(webEntries[path], `web entry ${path}`).toBe(desktopEntries[path])
    expect(cliEntries[path], `cli entry ${path}`).toBe(desktopEntries[path])
  }
  expect(Object.keys(webEntries).sort()).toEqual(Object.keys(desktopEntries).sort())
  expect(Object.keys(cliEntries).sort()).toEqual(Object.keys(desktopEntries).sort())
  // The manifests differ in exactly one field: the provenance stamp, which says when each export ran.
  // Everything else in them — counts, entries, digests, the source-party assertion — must agree.
  const desktopManifest = manifestParts(desktopBytes)
  const webManifest = manifestParts(webBytes)
  const cliManifest = manifestParts(cliBytes)
  expect(webManifest.manifest).toBe(desktopManifest.manifest)
  expect(cliManifest.manifest).toBe(desktopManifest.manifest)
  expect(webManifest.exportedAt).toBeTruthy()
  expect(cliManifest.exportedAt).toBeTruthy()

  // ---- the other direction: the CLI lands a package as a read-only session -------------------------
  const importStarted = Date.now()
  const { stdout: importStdout } = await execFileAsync(
    process.execPath,
    [
      join(APP_ROOT, 'packages', 'purescience', 'cli.mjs'),
      'package',
      'import',
      webPath,
      '--project',
      desktop.projectId,
      '--config-root',
      app.storageRoot,
      '--json'
    ],
    { cwd: APP_ROOT, timeout: 120_000 }
  )
  const importMs = Date.now() - importStarted
  const imported = JSON.parse(importStdout) as {
    ok: boolean
    sessionId: string
    posture: { readOnly: boolean; executeAllowed: boolean; verificationLabel: string }
    landed: { citations: number }
  }
  expect(imported.ok, importStdout).toBe(true)
  expect(imported.posture).toMatchObject({
    readOnly: true,
    executeAllowed: false,
    verificationLabel: 'source-party'
  })

  // The imported session is in the app's own catalog, with the message count the package carried — and
  // the import record sits beside it, which is what makes the session readable-but-not-runnable.
  const manifestCounts = (
    JSON.parse(strFromU8(unzipSync(desktopBytes)['manifest.json']!)) as {
      counts: { messages: number }
    }
  ).counts
  const importedSession = await page.evaluate(async (sessionId) => {
    const { api } = globalThis as unknown as { api: PackageApi }
    const raw = await api.sessions.loadAll()
    const sessions = (
      Array.isArray(raw) ? raw : ((raw as { sessions?: unknown[] }).sessions ?? [])
    ) as Array<{ id: string; messages?: unknown[]; status?: string }>
    const found = sessions.find((candidate) => candidate.id === sessionId)
    return found
      ? { found: true, messages: found.messages?.length ?? 0, status: found.status }
      : { found: false }
  }, imported.sessionId)
  expect(importedSession).toMatchObject({ found: true, messages: manifestCounts.messages })
  const importRecordPath = join(
    app.storageRoot,
    'sessions',
    desktop.projectId,
    `${imported.sessionId}.import.json`
  )
  expect(existsSync(importRecordPath), importRecordPath).toBe(true)

  // The readings also land OUTSIDE the per-test root, which teardown removes: the evidence file quotes
  // these numbers, and a number nobody can re-read is not evidence.
  const readingsPath = join(APP_ROOT, 'test-results', 'd1-session-package', 'readings.json')
  await mkdir(dirname(readingsPath), { recursive: true })
  await writeFile(
    readingsPath,
    `${JSON.stringify(
      {
        sessionId: desktop.sessionId,
        projectId: desktop.projectId,
        mode: 'full',
        desktop: {
          ms: desktopMs,
          bytes: desktopBytes.byteLength,
          sha256: sha256(desktopBytes),
          payloadSha256: payloadDigest(desktopEntries)
        },
        web: {
          ms: webMs,
          bytes: webBytes.byteLength,
          sha256: sha256(webBytes),
          payloadSha256: payloadDigest(webEntries)
        },
        import: {
          ms: importMs,
          sessionId: imported.sessionId,
          messages: importedSession.messages,
          recordPresent: existsSync(importRecordPath)
        },
        cli: {
          ms: cliMs,
          bytes: cliBytes.byteLength,
          sha256: sha256(cliBytes),
          payloadSha256: payloadDigest(cliEntries),
          reportedSha256: cliReport.sha256
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  )
})
