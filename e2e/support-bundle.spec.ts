import { expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import * as tar from 'tar'

import { test } from './fixtures/electron-app'

// The support bundle is the one artifact a user hands to someone outside their machine, so two properties
// are load-bearing: it is really produced by the running application, and it really carries no home
// directory, no user name and no secret-shaped value. Assembly has unit tests; this drives the path a person
// actually takes — Settings → Diagnostics → the button — through the renderer, preload and IPC to a file on
// disk. The native save dialog is the single seam replaced, because no test can operate a native dialog.

const openGeneralSettings = async (page: Page): Promise<Locator> => {
  // The header entry is labelled "Model settings" in this build; match on the settings word rather than the
  // exact label so a copy change does not silently break the flow.
  await page
    .getByRole('button', { name: /settings/i })
    .first()
    .click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  return settings
}

const listEntries = async (bundlePath: string): Promise<string[]> => {
  const entries: string[] = []
  await tar.list({
    file: bundlePath,
    onentry: (entry) => {
      // Files only: the archive also carries directory entries, and reading one as a file is an error.
      if (entry.type === 'File') entries.push(entry.path.replace(/^\.\//, ''))
    }
  })
  return entries
}

test('exports a scrubbed support bundle from the running app', async ({ app }) => {
  const page = await app.completeOnboarding()
  const root = await mkdtemp(join(tmpdir(), 'ps-support-bundle-e2e-'))
  const bundlePath = join(root, 'support-bundle.tar.gz')

  try {
    await app.stubSaveDialog(bundlePath)
    const settings = await openGeneralSettings(page)
    const button = settings.getByRole('button', { name: /Export support bundle/ })
    await expect(button).toBeVisible()
    await button.click()

    // The panel reports where the bundle went, and the file is really there.
    await expect(settings.getByText(bundlePath)).toBeVisible()
    expect((await stat(bundlePath)).size).toBeGreaterThan(0)

    const entries = await listEntries(bundlePath)
    expect(entries).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'environment.json',
        'runtime.json',
        'README.txt',
        'diagnostics/event-loop-stalls.json'
      ])
    )
    expect(entries.some((entry) => entry.startsWith('logs/'))).toBe(true)

    const extracted = join(root, 'extracted')
    await mkdir(extracted, { recursive: true })
    await tar.extract({ file: bundlePath, cwd: extracted })

    // The stall section is assembled from the watchdog's own ring in the main process, so its presence here
    // is the wiring: a bundle exported right after a hang must answer "what did the loop do" without a grep.
    // An empty list is a real answer and carries its own name, so the assertion allows it instead of requiring
    // a stall to have happened during the test.
    const stalls: { status: string; observed: number; dropped: number; records: unknown[] } =
      JSON.parse(await readFile(join(extracted, 'diagnostics/event-loop-stalls.json'), 'utf8'))
    expect(['records', 'no-stalls-observed']).toContain(stalls.status)
    expect(typeof stalls.observed).toBe('number')
    expect(stalls.dropped).toBeGreaterThanOrEqual(0)
    if (stalls.status === 'no-stalls-observed') {
      expect(stalls.records).toEqual([])
    } else {
      expect(stalls.records.length).toBeGreaterThan(0)
      // Every record names what held the loop, not just how much CPU the window burned: the low band used to
      // be the end of the story. A record without a cause — or with one of the two states that admit the
      // instruments did not decide it — is a reading a maintainer cannot act on.
      for (const record of stalls.records as Array<{ cause?: { kind?: string; basis?: string } }>) {
        expect(
          record.cause?.kind,
          `stall record without a cause: ${JSON.stringify(record)}`
        ).toBeDefined()
        expect(record.cause?.basis, 'a cause has to carry the numbers behind it').toBeTruthy()
      }
    }

    // The machine's own timeline: the sampler runs on its own thread from boot, so a bundle exported here must
    // carry real readings (not an empty list) and say which of the three states it is in. This is the half the
    // stall records cannot answer — a report with no stall window at all.
    expect(entries).toContain('diagnostics/host-timeline.json')
    const timeline: {
      status: string
      reason?: string
      capturedAt: string
      intervalMs?: number
      sampleCount?: number
      sampleCapacity?: number
      spanMs?: number
      oldestAt?: string
      newestAt?: string
      samples?: { at: string; cpuMs: number }[]
      paging?: { status: string; reason?: string; readings?: unknown[] }
    } = JSON.parse(await readFile(join(extracted, 'diagnostics/host-timeline.json'), 'utf8'))
    expect(['timeline', 'no-samples', 'unavailable']).toContain(timeline.status)
    expect(Date.parse(timeline.capturedAt)).not.toBeNaN()
    if (timeline.status === 'timeline') {
      // The sampler ticks four times a second and the app has been up for the whole test, so at least one
      // reading must exist: an empty samples array here would mean the section shipped without its content.
      expect(timeline.samples?.length ?? 0).toBeGreaterThan(0)
      expect(timeline.sampleCount).toBe(timeline.samples?.length)
      expect(timeline.spanMs).toBeGreaterThanOrEqual(0)
      expect(Date.parse(timeline.oldestAt ?? '')).not.toBeNaN()
      expect(Date.parse(timeline.newestAt ?? '')).not.toBeNaN()
      expect(timeline.intervalMs).toBeGreaterThan(0)
      expect(timeline.sampleCapacity).toBeGreaterThan(0)
      // Printed so the reading is auditable from the log, not just an assertion that passed: the numbers a
      // bundle reader sees are the evidence for this section existing at all.
      console.log(
        `[e2e] host-timeline status=${timeline.status} samples=${timeline.sampleCount} capacity=${timeline.sampleCapacity} dropped=${(timeline as { samplesDropped?: number }).samplesDropped ?? 'not-reported'} spanMs=${timeline.spanMs} intervalMs=${timeline.intervalMs} paging=${timeline.paging?.status}${timeline.paging?.status === 'readings' ? `:${timeline.paging.readings?.length}` : `:${timeline.paging?.reason}`}`
      )
      // Whichever platform this lane runs on: readings when the counters are readable, otherwise a named
      // reason — never an empty list pretending nothing paged.
      if (timeline.paging?.status === 'readings')
        expect(timeline.paging.readings?.length).toBeGreaterThan(0)
      else
        expect(['platform-exposes-no-counters', 'no-counters-parsed']).toContain(
          timeline.paging?.reason
        )
    } else if (timeline.status === 'no-samples') {
      expect(timeline.samples).toBeUndefined()
    } else {
      expect(['sampler-not-started', 'no-answer']).toContain(timeline.reason)
    }

    const manifest: Record<string, unknown> = JSON.parse(
      await readFile(join(extracted, 'manifest.json'), 'utf8')
    )
    expect(String(manifest.application)).toMatch(/^\d+\.\d+\.\d+/)
    expect(manifest.electron).toBeTruthy()
    expect(manifest.packaged).toBe(false)

    // The storage location is recorded as a class, never as a path.
    const runtime = await readFile(join(extracted, 'runtime.json'), 'utf8')
    expect(['default', 'custom']).toContain(JSON.parse(runtime).storageLocation)
    expect(runtime).not.toContain('/')

    // What actually ships must not carry the home directory or the user name, in any file.
    // Portable source of truth: HOME is unset on Windows, so ask the OS instead of reading the environment.
    const home = homedir()
    const userName = userInfo().username
    expect(home).not.toBe('')
    for (const entry of entries) {
      const contents = await readFile(join(extracted, entry), 'utf8')
      expect(contents).not.toContain(home)
      expect(contents).not.toContain(userName)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a cancelled export writes nothing and leaves the panel unchanged', async ({ app }) => {
  const page = await app.completeOnboarding()
  await app.stubSaveDialog(null)

  const settings = await openGeneralSettings(page)
  const button = settings.getByRole('button', { name: /Export support bundle/ })
  await button.click()
  // The button re-enables when the export settles, which is the signal that the cancelled run has finished.
  await expect(button).toBeEnabled()

  await expect(settings.getByText(/Support bundle saved to/)).toHaveCount(0)
  await expect(settings.getByRole('alert')).toHaveCount(0)
})
