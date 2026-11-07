import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import * as tar from 'tar'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Real-window acceptance for the idle-kernel cpu section of the support bundle.
//
// Two neighbouring pieces of evidence already exist and neither covers this one: the unit suite proves the
// ring turns two cumulative-cpu readings into a window, and `support-bundle-export-readback` proves the
// section is written when no kernel ever ran (its honest `monitor-not-started` state). What a user's bundle
// actually carries once a kernel HAS run — the reading that turns "the machine got slow and the fan never
// stopped" into a number — had never been read from a real kernel.
//
// So this starts a REAL python kernel through the session's own notebook channels (the same two the pane
// calls; no agent turn and no provider involved, because neither has anything to do with the reading), waits
// for the monitor's first *completed* window (the first tick only takes a baseline, so the second one —
// ~30 s after spawn — is the first record), exports the bundle through the panel, and reads the section back
// out of the archive the app wrote.
//
// The kernel it starts is whatever python this isolated instance can enable. `test.skip` names that
// precondition instead of failing: a machine with no python must not read as "the monitor is broken".
test.setTimeout(900_000)

type KernelCpuWindow = {
  key: string
  kind: string
  env: string
  pid: number
  cpuPercent: number
  windowMs: number
  thresholdPercent: number
  spinning: boolean
  at: string
}

type KernelCpuSection = {
  status: string
  monitor: string
  capacity: number
  observed: number
  dropped: number
  oldestAt?: string
  newestAt?: string
  unsampledReasons: string[]
  latest: KernelCpuWindow[]
  records: KernelCpuWindow[]
}

type StartOutcome = {
  missing?: string
  runtimeId?: string
  interpreterPath?: string
  runStatus?: string
  runId?: string
}

test('the support bundle carries what a real kernel was doing while idle', async ({ app }) => {
  const page = await app.completeOnboarding()
  const projectId = await createProject(page, 'Kernel cpu in the bundle')
  const workspaceCwd = join(app.storageRoot, 'kernel-cpu-workspace')
  await mkdir(workspaceCwd, { recursive: true })
  const sessionId = randomUUID()

  const start = await page.evaluate(
    async ({ projectId: owner, sessionId: id, cwd }) => {
      const bridge = globalThis as unknown as {
        api: {
          sessions: { saveSession: (session: unknown) => Promise<unknown> }
          runtime: {
            listEnvironments: () => Promise<{
              python: {
                envId: string
                interpreterPath: string
                label: string
                runnable: boolean
              }[]
            }>
            setEnvironmentEnabled: (
              language: 'python',
              envId: string,
              enabled: boolean
            ) => Promise<unknown>
          }
          notebook: {
            listRuntimes: (request: unknown) => Promise<{
              runtimes: {
                language: string
                runtimeId: string
                interpreterPath: string
                runnable: boolean
              }[]
            }>
            bindRuntime: (request: unknown) => Promise<unknown>
            execute: (request: unknown) => Promise<unknown>
          }
        }
      }
      const now = Date.now()
      await bridge.api.sessions.saveSession({
        id,
        projectId: owner,
        title: 'Kernel cpu in the bundle',
        cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        messages: []
      })

      const environments = await bridge.api.runtime.listEnvironments()
      const candidates = environments.python.filter((entry) => entry.runnable !== false)
      if (candidates.length === 0) {
        return { missing: 'no runnable python interpreter on this machine' }
      }
      // A user-owned interpreter is off until someone opts in — the same gate Settings → Runtimes writes.
      await bridge.api.runtime.setEnvironmentEnabled('python', candidates[0].envId, true)

      const listed = await bridge.api.notebook.listRuntimes({ sessionId: id, workspaceCwd: cwd })
      const pythonRuntime = listed.runtimes.find(
        (entry) => entry.language === 'python' && entry.runnable !== false
      )
      if (!pythonRuntime) {
        return { missing: 'no enabled python runtime after the opt-in' }
      }
      await bridge.api.notebook.bindRuntime({
        sessionId: id,
        workspaceCwd: cwd,
        language: 'python',
        runtimeId: pythonRuntime.runtimeId
      })
      const run = (await bridge.api.notebook.execute({
        sessionId: id,
        workspaceCwd: cwd,
        code: 'print("kernel cpu probe")',
        language: 'python'
      })) as { status?: string; runId?: string }
      return {
        runtimeId: pythonRuntime.runtimeId,
        interpreterPath: pythonRuntime.interpreterPath,
        runStatus: run.status,
        runId: run.runId
      }
    },
    { projectId, sessionId, cwd: workspaceCwd }
  )

  const started = start as StartOutcome
  test.skip(started.missing !== undefined, started.missing ?? 'no python runtime to start a kernel')
  // The cell really ran: a refused or failed run would never spawn a kernel, and then the section below
  // would be read from a monitor that had nothing to watch.
  expect(started.runStatus).toBe('completed')
  console.log(
    `[kernel-cpu] kernel started: runtime=${started.runtimeId} run=${started.runId} status=${started.runStatus}`
  )

  const bundlePath = join(app.storageRoot, 'kernel-cpu-bundle.zip')
  await app.stubSaveDialog(bundlePath)
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()

  const extracted = join(app.storageRoot, 'kernel-cpu-extracted')

  const readSection = async (): Promise<KernelCpuSection> => {
    await mkdir(extracted, { recursive: true })
    await tar.extract({ file: bundlePath, cwd: extracted })
    return JSON.parse(
      await readFile(join(extracted, 'diagnostics/notebook-kernel-cpu.json'), 'utf8')
    ) as KernelCpuSection
  }

  // The sampling interval is 15 s and the first tick only takes a baseline, so the first *record* lands on
  // the second tick. Export after that, and give it two more windows if this run was slow to idle — each
  // attempt is another real export, and the numbers asserted below come from the archive, never from here.
  let section: KernelCpuSection | undefined
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.waitForTimeout(attempt === 1 ? 35_000 : 12_000)
    await settings.getByRole('button', { name: /Export support bundle/i }).click()
    await expect(settings.getByText(/Support bundle saved to/i).first()).toBeVisible({
      timeout: 60_000
    })
    section = await readSection()
    console.log(
      `[kernel-cpu] attempt ${attempt}: status=${section.status}, monitor=${section.monitor}, ` +
        `observed=${section.observed}, latest=${section.latest.length}, ` +
        `reasons=${section.unsampledReasons.join(',') || '(none)'}`
    )
    if (section.status === 'samples') break
  }

  expect(section).toBeDefined()
  // The state this spec exists for: a window completed while the kernel was idle.
  expect(section?.status).toBe('samples')
  expect(['running', 'stopped']).toContain(section?.monitor)
  expect(section?.unsampledReasons).not.toContain('unsupported-platform')
  expect(section?.capacity).toBeGreaterThan(0)
  expect(section?.observed).toBeGreaterThanOrEqual(1)
  expect(section?.dropped).toBe(section!.observed - (section?.records.length ?? 0))
  expect(section?.records.length).toBeGreaterThan(0)
  expect(section?.latest.length).toBeGreaterThan(0)

  for (const record of section!.records) {
    // A pid and a percentage, not a placeholder: this is the pair a reader uses to find the process.
    expect(Number.isInteger(record.pid)).toBe(true)
    expect(record.pid).toBeGreaterThan(0)
    expect(Number.isFinite(record.cpuPercent)).toBe(true)
    expect(record.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(record.windowMs).toBeGreaterThan(0)
    expect(record.key.length).toBeGreaterThan(0)
    expect(record.env.length).toBeGreaterThan(0)
    expect(Number.isFinite(Date.parse(record.at))).toBe(true)
    // `spinning` is derived from the threshold on the row itself, so a reader can check the claim.
    expect(record.spinning).toBe(record.cpuPercent >= record.thresholdPercent)
  }

  const newest = section!.latest[section!.latest.length - 1]
  console.log(
    `[kernel-cpu] newest window per kernel: pid=${newest.pid}, cpuPercent=${newest.cpuPercent}, ` +
      `windowMs=${newest.windowMs}, spinning=${newest.spinning}, env=${newest.env}`
  )
  expect(Number.isInteger(newest.pid)).toBe(true)
  expect(newest.pid).toBeGreaterThan(0)
})
