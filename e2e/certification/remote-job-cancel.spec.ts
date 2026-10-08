import { execFileSync } from 'node:child_process'
import { userInfo, homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// IC39 on a REAL host: stopping a running remote job from the window, against a genuine SSH endpoint
// (a user-mode sshd on a high port — no docker, no system change). The row and the button both already
// have unit coverage; what only a live machine can show is the two halves the feature exists for:
//
//   ①「能送到」  the kill really reaches the host: the window reports the stop, the row reads
//      `cancelled`, and the remote process is gone (checked over SSH, not from the app's own word).
//   ②「送不到」  when the host cannot be reached the window must NOT report a stop: it states the
//      refusal and the row stays `running` (a cancellation that could not be delivered must not be
//      written as one). The host is taken away in both halves — listener and the multiplexed
//      connection the app is already holding (see `closeMux`).
//
// A third reading falls out of the same run and is the reason the fixture submits through the
// notebook REPL: the submission path is `repl_execute` → `host.compute.submit_job`, and the
// execution-protection policy is consulted BEFORE the approval card. Under the default `deny` the
// tool must answer `protection_refused` with no card ever shown — the old copy said "Approval denied
// for submit_job", which sent two earlier attempts looking for a grant that was never in play.
//
// Prerequisites (all outside the app, none system-level):
//   • a user-mode sshd listening on 127.0.0.1:2222, its host key already accepted by the app
//     (`ssh-keyscan -p 2222 127.0.0.1 >> ~/.ssh/known_hosts`), key dir given by
//     PURESCIENCE_IC39_SSH_DIR (default /tmp/ps-ic39-ssh);
//   • `npm run build:e2e` first — the e2e instance loads the e2e bundle, not `build:web`.
test.setTimeout(900_000)

const HOST_ALIAS = '127.0.0.1'
const PROVIDER_ID = `ssh:${HOST_ALIAS}`
const SSH_PORT = '2222'
const SSH_DIR = process.env.PURESCIENCE_IC39_SSH_DIR ?? '/tmp/ps-ic39-ssh'
const SSH_IDENTITY = `${SSH_DIR}/id_ed25519`
const SSH_USER = userInfo().username
const JOB_COMMAND = 'sleep 300'
// `pgrep -f` also matches the argv of the very shell running it, so a pattern quoted literally into
// the remote command line counts ITSELF — measured: a plain `pgrep -f "sleep 300"` reads 1 on a host
// where nothing is running. The bracketed first character matches the workload while the argv carries
// the bracketed form, which the same regex does not match.
const SLEEP_PATTERN = `[${JOB_COMMAND[0]}]${JOB_COMMAND.slice(1)}`
// The refusal the window must state when the kill cannot be delivered, verbatim from the en dictionary.
const HOST_UNREACHABLE_COPY =
  'The host could not be reached, so the job was not stopped and is still running.'
const CANCEL_DONE_COPY = 'Stop requested — the job is now cancelled.'
// Phrases unique to the execution-protection refusal (the copy that replaced the misleading
// "Approval denied for submit_job"): nothing was submitted and nobody was asked.
const PROTECTION_REFUSED_MARKERS = [
  'refused by the execution-protection policy',
  'nothing was submitted and no approval was requested'
]

type JobLike = {
  job_id: string
  session_id: string
  status: string
  intent: string
  error_code?: string
  remote_workdir?: string
}

type Bridge = {
  compute: {
    create: (request: unknown) => Promise<unknown>
    get: (providerId: string) => Promise<{ probeResult?: { ok?: boolean; os?: string } } | null>
    probe: (
      providerId: string
    ) => Promise<{ ok?: boolean; os?: string; errorTail?: string | null } | null>
    jobsList: (filter: { sessionId: string }) => Promise<JobLike[]>
  }
  settings: {
    executionProtection: (request: unknown) => Promise<unknown>
  }
  sessions: {
    loadAll: () => Promise<unknown>
  }
}

const sshArgs = (command: string): string[] => [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'ConnectTimeout=5',
  '-i',
  SSH_IDENTITY,
  '-p',
  SSH_PORT,
  `${SSH_USER}@127.0.0.1`,
  command
]

// The remote side of the reading. `pgrep -f` proves whether the submitted workload is really running
// on the host, so "the job was stopped" is checked against the host rather than taken from the app's
// own answer (see SLEEP_PATTERN for why the pattern is bracketed).
const remoteSleepCount = (): number => {
  try {
    const out = execFileSync('ssh', sshArgs(`pgrep -f '${SLEEP_PATTERN}' | wc -l`), {
      encoding: 'utf8'
    }).trim()
    return Number.parseInt(out, 10) || 0
  } catch {
    return -1
  }
}

// Reads one line from the host. Used by the diagnostics below so a failing run states the raw facts
// (the row, the recorded pid, whether that pid is alive) instead of only the window's wording.
const sshOut = (command: string): string => {
  try {
    return execFileSync('ssh', sshArgs(command), { encoding: 'utf8' }).trim()
  } catch (error) {
    return `ssh failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

// One-shot host hygiene: the last job of this run is deliberately left addressable (the refusal case
// keeps it running), so it is stopped here rather than left sleeping for five minutes on the endpoint.
const clearRemoteWorkloads = (): void => {
  execFileSync('bash', [
    '-lc',
    `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i ${SSH_IDENTITY} -p ${SSH_PORT} ` +
      `${SSH_USER}@127.0.0.1 "pkill -f '${SLEEP_PATTERN}' || true"`
  ])
}

const stopSshd = (): void => {
  execFileSync('bash', ['-lc', `pkill -f "sshd -f ${SSH_DIR}/sshd_config" || true`])
}

// Taking the listener down is NOT the same as taking the host away. The app multiplexes its SSH
// connections (`ControlMaster=auto`, `ControlPersist=60` — see `controlMasterArgs`), so the session it
// already holds survives as its own sshd process and the next `ssh` reuses that live mux: measured on
// the first live run of this spec, the kill still landed (the host workload was gone) while the
// assertion expected a refusal. A host that is really unreachable has no surviving connection either,
// so the mux client and its sockets go down with the listener, and the spec then proves the port is
// closed before it asks the window to stop anything.
const CONTROL_DIR = join(homedir(), '.ssh', 'ctrl')

const closeMux = (): void => {
  execFileSync('bash', [
    '-lc',
    `pkill -f "${CONTROL_DIR}/" || true; rm -f "${CONTROL_DIR}/"* 2>/dev/null || true`
  ])
}

const hostUnreachable = (): boolean => {
  try {
    execFileSync('ssh', sshArgs('echo SSH_OK'), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return false
  } catch {
    return true
  }
}

const startSshd = (): void => {
  execFileSync('bash', ['-lc', `/usr/sbin/sshd -f ${SSH_DIR}/sshd_config -E ${SSH_DIR}/sshd.log`])
}

// Whether this machine has the endpoint this reading is about. A lane that cannot host a user-mode sshd
// (CI has no 127.0.0.1:2222) must skip rather than fail: a red lane there would say nothing about the
// product. Same shape as the curated-pack gates in the neighbouring certification specs.
const endpointReachable = (): boolean => {
  try {
    return (
      execFileSync('ssh', sshArgs('echo SSH_OK'), {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() === 'SSH_OK'
    )
  } catch {
    return false
  }
}

const sendPrompt = async (page: Page, prompt: string): Promise<void> => {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
}

const sessionId = async (page: Page): Promise<string> => {
  let found = ''
  await expect
    .poll(
      async () => {
        found = await page.evaluate(async () => {
          const api = (globalThis as unknown as { api: Bridge }).api
          const raw = (await api.sessions.loadAll()) as
            | Array<{ id: string; updatedAt?: number }>
            | { sessions?: Array<{ id: string; updatedAt?: number }> }
            | { items?: Array<{ id: string; updatedAt?: number }> }
          const nested =
            (raw as { sessions?: unknown }).sessions ?? (raw as { items?: unknown }).items
          const items = Array.isArray(raw)
            ? (raw as Array<{ id: string; updatedAt?: number }>)
            : Array.isArray(nested)
              ? (nested as Array<{ id: string; updatedAt?: number }>)
              : []
          const newest = [...items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
          return newest?.id ?? ''
        })
        return found
      },
      { timeout: 60_000, intervals: [1000] }
    )
    .not.toBe('')
  if (!found) throw new Error('no session was persisted yet')
  return found
}

const jobs = async (page: Page, id: string): Promise<JobLike[]> =>
  page.evaluate(async (sessionId) => {
    const api = (globalThis as unknown as { api: Bridge }).api
    return api.compute.jobsList({ sessionId })
  }, id)

// Opens the job list from the window's own badge, picks the newest row, and presses the detail
// header's cancel control — the product path, not a channel call.
const cancelNewestJobFromWindow = async (page: Page): Promise<void> => {
  const badge = page.getByRole('button', { name: /running remote jobs?/ })
  // A failure here used to read only "locator timed out". Dump what the window actually offers, so
  // the run states whether the entry is absent or merely named differently.
  if ((await badge.count()) === 0) {
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '')
        .filter((label) => label !== '')
        .slice(0, 60)
    )
    console.log(`[ic39] no running-jobs badge; buttons on screen: ${JSON.stringify(labels)}`)
  }
  await badge.first().click()
  const list = page.getByTestId('session-jobs-list')
  await expect(list).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('session-job-row').first().click()
  const cancel = page.getByTestId('job-cancel')
  await expect(cancel).toBeVisible({ timeout: 30_000 })
  await cancel.click()
}

const cancelResult = async (page: Page): Promise<string> =>
  page.locator('[data-slot="job-cancel-result"]').first().innerText()

test('IC39: a window-initiated cancel reaches a live host — and is refused, not written, when it cannot', async ({
  app
}) => {
  test.skip(!endpointReachable(), `no user-mode sshd on 127.0.0.1:${SSH_PORT}`)

  // Read the endpoint before touching the app: a dead sshd would make every later step look like a
  // product failure. "Running" is proven by one real SSH round-trip, not by the port being open.
  const probe = execFileSync('ssh', sshArgs('echo SSH_OK'), { encoding: 'utf8' }).trim()
  expect(probe).toBe('SSH_OK')

  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'IC39 live host')

  // ── the app really registers and reaches this host ───────────────────────────────────────────
  await page.evaluate(
    async ({ alias, overrides }) => {
      const api = (globalThis as unknown as { api: Bridge }).api
      await api.compute.create({ sshAlias: alias, sshOverrides: overrides })
    },
    {
      alias: HOST_ALIAS,
      overrides: { user: SSH_USER, port: Number.parseInt(SSH_PORT, 10), identityFile: SSH_IDENTITY }
    }
  )
  let probed: { ok?: boolean; os?: string; errorTail?: string | null } | null | undefined
  await expect
    .poll(
      async () => {
        probed = await page.evaluate(async (providerId) => {
          const api = (globalThis as unknown as { api: Bridge }).api
          return (await api.compute.probe(providerId)) ?? null
        }, PROVIDER_ID)
        return probed?.ok
      },
      { timeout: 90_000, intervals: [2000] }
    )
    .toBe(true)
  console.log(`[ic39] the app probed the host itself: ${JSON.stringify(probed)}`)

  // ── ① the policy gate answers before any card (default `deny`) ───────────────────────────────
  await sendPrompt(page, 'Submit a long remote job.')
  const refused = page.getByText(/^Remote submit refused:/)
  await expect(refused).toBeVisible({ timeout: 120_000 })
  const refusedText = await refused.innerText()
  console.log(`[ic39] default-policy submission answer: ${refusedText.slice(0, 260)}`)
  for (const marker of PROTECTION_REFUSED_MARKERS) {
    expect(refusedText, `the refusal does not state "${marker}"`).toContain(marker)
  }
  // Nobody was asked: a card on this path would mean the policy was consulted after the approval,
  // which is the defect the refusal copy was fixed to describe.
  await expect(page.getByRole('dialog', { name: 'Allow remote command?' })).toHaveCount(0)
  // The session is only persisted once a turn has run, so it is read here rather than before it.
  const id = await sessionId(page)
  console.log(`[ic39] session ${id}`)
  expect(await jobs(page, id), 'a refused submission wrote a job row').toEqual([])

  // ── ② under `confirm` the card is raised; approving it runs the job for real ─────────────────
  await page.evaluate(async () => {
    const api = (globalThis as unknown as { api: Bridge }).api
    await api.settings.executionProtection({ action: 'set-remote-policy', policy: 'confirm' })
  })
  await sendPrompt(page, 'Submit a long remote job.')
  const card = page.getByRole('dialog', { name: 'Allow remote command?' })
  await expect(card).toBeVisible({ timeout: 120_000 })
  await card.getByRole('button', { name: 'Once' }).click()
  await expect(page.getByText(/^Remote submit accepted:/)).toBeVisible({ timeout: 120_000 })

  let running: JobLike | undefined
  await expect
    .poll(
      async () => {
        const list = await jobs(page, id)
        running = list.find((job) => job.status === 'running')
        return running?.status ?? list[0]?.status ?? 'none'
      },
      { timeout: 120_000, intervals: [1000] }
    )
    .toBe('running')
  console.log(`[ic39] job dispatched and running: ${JSON.stringify(running)}`)
  // The command is really executing on the host — the app's row is not the only witness.
  expect(remoteSleepCount(), 'the submitted command is not running on the host').toBeGreaterThan(0)

  // ── ③「能送到」: the window stops it, the row reads cancelled, the host process is gone ───────
  // State the raw facts before asking the window to stop anything: the rows (with their status and
  // error code), the pid the host has on file, and whether that pid is alive. A window that reports
  // `running` while the row holds a terminal status is then a reading, not a guess.
  const preCancel = await jobs(page, id)
  console.log(
    `[ic39] rows before the cancel: ${JSON.stringify(
      preCancel.map((job) => ({
        id: job.job_id.slice(0, 8),
        status: job.status,
        error_code: job.error_code ?? null,
        workdir: job.remote_workdir ?? null
      }))
    )}`
  )
  const recordedPid = sshOut(`cat ${running!.remote_workdir}/job.pid`)
  console.log(
    `[ic39] host pid file = ${recordedPid}; that pid is ${sshOut(
      `kill -0 ${recordedPid} 2>/dev/null && echo alive || echo dead`
    )}; workload processes on the host = ${remoteSleepCount()}`
  )
  await cancelNewestJobFromWindow(page)
  // Read the banner first, then judge it: the wording plus the row it refers to is the evidence.
  const cancelBanner = page.locator('[data-slot="job-cancel-result"]').first()
  await expect(cancelBanner).not.toBeEmpty({ timeout: 60_000 })
  const cancelText = await cancelBanner.innerText()
  const afterCancel = (await jobs(page, id)).find((job) => job.job_id === running!.job_id)
  console.log(
    `[ic39] cancel banner: ${cancelText} | row=${JSON.stringify(afterCancel)} | sleeps=${remoteSleepCount()}`
  )
  expect(cancelText).toBe(CANCEL_DONE_COPY)
  expect(afterCancel?.status, 'the row was not written as cancelled').toBe('cancelled')
  await expect.poll(() => remoteSleepCount(), { timeout: 30_000, intervals: [1000] }).toBe(0)

  // ── ④「送不到」: unreachable host ⇒ refusal stated, row still running ─────────────────────────
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('job-detail-modal')).toHaveCount(0)
  await sendPrompt(page, 'Submit a long remote job.')
  await expect(card).toBeVisible({ timeout: 120_000 })
  await card.getByRole('button', { name: 'Once' }).click()
  await expect(page.getByText(/^Remote submit accepted:/)).toBeVisible({ timeout: 120_000 })
  let second: JobLike | undefined
  await expect
    .poll(
      async () => {
        const list = await jobs(page, id)
        second = list.find((job) => job.status === 'running' && job.job_id !== running!.job_id)
        return second?.status ?? 'none'
      },
      { timeout: 120_000, intervals: [1000] }
    )
    .toBe('running')
  console.log(`[ic39] second job running: ${JSON.stringify(second)}`)

  // Take the host away, then ask the window to stop the job: the kill cannot be delivered.
  // Both halves are required — the listener alone leaves a live mux (see `closeMux`), and the spec
  // proves the port is closed before it asks for the stop, so a refusal further down cannot be an
  // artefact of an endpoint that was still reachable.
  stopSshd()
  closeMux()
  await expect.poll(hostUnreachable, { timeout: 30_000, intervals: [500] }).toBe(true)
  await cancelNewestJobFromWindow(page)
  // The banner carries the window's own wording AND, beneath it, the fact the main process observed.
  // Both are asserted: a refusal that names no reason is indistinguishable from a blanket refusal, and
  // the raw exit status is what tells the user the stop command itself never reached the host.
  const refusalBanner = page.locator('[data-slot="job-cancel-result"]').first()
  await expect(refusalBanner).toContainText(HOST_UNREACHABLE_COPY, {
    timeout: 90_000
  })
  await expect(refusalBanner).toContainText('exit code 255')
  const afterRefusal = (await jobs(page, id)).find((job) => job.job_id === second!.job_id)
  console.log(
    `[ic39] refusal result: ${await cancelResult(page)} | row=${JSON.stringify(afterRefusal)}`
  )
  expect(
    afterRefusal?.status,
    'a cancellation that could not be delivered was written as one'
  ).toBe('running')

  // Leave the endpoint as it was found: later runs (and the app's own poller) need it listening.
  startSshd()
  await expect
    .poll(() => execFileSync('ssh', sshArgs('echo SSH_OK'), { encoding: 'utf8' }).trim(), {
      timeout: 30_000,
      intervals: [1000]
    })
    .toBe('SSH_OK')

  // The refusal case deliberately leaves its job running; stop it here so the run does not leave a
  // sleeping workload (and an app-side poller tail) behind on the host.
  clearRemoteWorkloads()
  console.log(`[ic39] leftover workloads on the host after cleanup: ${remoteSleepCount()}`)
})
