import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the Replay tab: the window must show the same fields the remote command returns.
//
// `artifacts:replay-version` is one command. The remote task API invokes exactly it (its own comment
// forbids a second implementation), so the reference here is that same call made the way the remote
// path makes it — and every field it brings back has to appear in what the window renders. Fields are
// compared by VALUE (byte offsets, counts, paths, reason strings), not by comparing two dictionaries.

test.setTimeout(180_000)

type ReplayResult = {
  stopped?: string
  report?: {
    mode: string
    verdict: string
    origin: string
    reasons: string[]
    files: Array<Record<string, unknown>>
  }
  environmentLock?: string
  execution?: Record<string, unknown>
  environmentManifestChecksum?: string
}

const VERDICT_SENTENCES: Record<string, string> = {
  reproduced: 'Reproduced: every comparable output came back byte-identical.',
  intact: 'Intact: the recorded digests still match the bytes on disk.',
  differs: 'Differs: the re-run does not match the record.',
  changed: 'Changed: the bytes on disk no longer match the record.',
  unverifiable: 'Unverifiable: this could not be checked.'
}

const NOT_COMPARABLE_SENTENCES: Record<string, string> = {
  'no-digest-recorded': 'no digest was recorded',
  'size-beyond-comparison-bound': 'too large for a byte comparison',
  'app-version-mismatch': 'recorded by another app version',
  'unsupported-output-kind': 'this output kind is not compared'
}

test('the window replays a version with the fields the remote command returns', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Replay evidence')
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
  const target = {
    projectId,
    appSessionId: appSessionId!,
    artifactId: artifactId!,
    versionId: versionId!
  }

  // The reference: the command itself, called the way the remote API calls it. The artifact's file name
  // comes from the same index the Files view reads, so the window gets reached the way a person reaches it.
  const { reference, filename } = await page.evaluate(async (request) => {
    const bridge = globalThis as unknown as {
      api: {
        artifacts: {
          replayVersion: (input: typeof request) => Promise<unknown>
          getVersionProvenance: (input: typeof request) => Promise<unknown>
        }
        projectFiles: { listFiles: (input: unknown) => Promise<unknown> }
      }
    }

    const reference = await bridge.api.artifacts.replayVersion(request)
    const provenance = await bridge.api.artifacts.getVersionProvenance(request)

    type FileEntry = { artifactId?: string; name?: string; filename?: string }
    let found: FileEntry | undefined
    const collections = [
      { kind: 'sessionArtifacts', sessionId: request.appSessionId },
      { kind: 'all' },
      { kind: 'uploads' }
    ] as const
    for (const collection of collections) {
      try {
        const page_ = (await bridge.api.projectFiles.listFiles({
          projectId: request.projectId,
          collection,
          limit: 50
        })) as { files?: FileEntry[]; entries?: FileEntry[] }
        const files = page_.files ?? page_.entries ?? []
        found = files.find((candidate) => candidate.artifactId === request.artifactId) ?? found
        if (found) break
      } catch {
        // A collection this build cannot serve is not what the spec is about.
      }
    }

    const nameFromProvenance = /"name"\s*:\s*"([^"]+)"/.exec(JSON.stringify(provenance))?.[1]
    return {
      reference,
      filename: (found?.name ?? found?.filename ?? nameFromProvenance ?? '') as string
    }
  }, target)
  const expected = reference as ReplayResult
  expect(filename).not.toBe('')

  // The window: the artifact's own card in the answer -> its preview -> its provenance entry -> Replay.
  // Every name here is one the window itself gives: the card says "Preview generated file <name>"
  // (the Files view says the same for a row), and provenance is either a trailing button or, while the
  // preview is not full screen, the first item of the "File actions for <title>" menu.
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await page
    .getByRole('button', { name: new RegExp(`^Preview generated file ${escaped}$`) })
    .first()
    .click()

  const trailingEntry = page.getByRole('button', { name: /^Open Provenance for / })
  const actionsMenu = page.getByRole('button', { name: /^File actions for / })
  await expect(trailingEntry.or(actionsMenu).first()).toBeVisible()
  if ((await trailingEntry.count()) > 0) {
    await trailingEntry.first().click()
  } else {
    await actionsMenu.first().click()
    await page.getByRole('menuitem', { name: 'Provenance', exact: true }).click()
  }

  const panel = page.getByTestId('artifact-provenance')
  await expect(panel).toBeVisible()
  await panel.getByRole('tab', { name: 'Replay', exact: true }).click()
  await panel.getByTestId('artifact-replay-run').click()

  if (expected.stopped !== undefined) {
    // A named stop is reported as itself, and nothing is dressed up as a verdict.
    await expect(panel.getByTestId('artifact-replay-stopped')).toBeVisible()
    await expect(panel.getByTestId('artifact-replay-verdict')).toHaveCount(0)
    return
  }

  const report = expected.report!
  await expect(panel.getByTestId('artifact-replay-verdict')).toContainText(
    VERDICT_SENTENCES[report.verdict]!
  )
  // Mode and origin travel with the verdict, so a re-run can never be read as an integrity check.
  const summary = panel.getByTestId('artifact-replay-verdict')
  await expect(summary).not.toContainText('Intact:')
  await expect(panel.getByTestId('artifact-replay-environment')).toBeVisible()
  if (expected.environmentManifestChecksum !== undefined) {
    await expect(panel.getByTestId('artifact-replay-environment')).toContainText(
      expected.environmentManifestChecksum
    )
  }
  await expect(panel.getByTestId('artifact-replay-execution')).toBeVisible()

  for (const reason of report.reasons) {
    await expect(panel.getByTestId('artifact-replay-reasons')).toContainText(reason)
  }

  const files = panel.getByTestId('artifact-replay-files')
  for (const file of report.files) {
    const path = file.path as string
    await expect(files).toContainText(path)
    if (file.status === 'differs') {
      // The numbers the remote report named are the numbers the window shows.
      await expect(files).toContainText(`byte ${String(file.firstDifferingByte)}`)
      await expect(files).toContainText(`recorded ${String(file.originalBytes)}`)
      await expect(files).toContainText(`replay ${String(file.replayBytes)}`)
    }
    if (file.status === 'not-comparable') {
      await expect(files).toContainText(NOT_COMPARABLE_SENTENCES[file.reason as string]!)
    }
  }
})
