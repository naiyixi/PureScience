import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  env?: Record<string, string>
  if?: string
  name?: string
  run?: string
}
type Job = {
  env?: Record<string, string>
  if?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  'runs-on'?: string
  steps?: Step[]
  'timeout-minutes'?: number
}
type Workflow = { jobs?: Record<string, Job | undefined>; on?: unknown }

const readWorkflow = (): Workflow =>
  load(
    readFileSync(join(process.cwd(), '.github/workflows/macos-upgrade-smoke.yml'), 'utf8')
  ) as Workflow

const readDrillScript = (): string =>
  readFileSync(join(process.cwd(), 'scripts/macos-upgrade-certification.mjs'), 'utf8')

const jobOf = (workflow: Workflow, id: string): Job => {
  const job = workflow.jobs?.[id]
  expect(job, `the workflow has no ${id} job`).toBeDefined()
  return job as Job
}

const stepNamed = (job: Job, name: string): Step => {
  const step = (job.steps ?? []).find((candidate) => candidate.name === name)
  expect(step, `the job has no step called ${name}`).toBeDefined()
  return step as Step
}

describe('macOS upgrade smoke workflow', () => {
  it('waits for the mirror on a cheap runner, not on the macOS one', () => {
    // Measured on run 45090413547: the tag lane started at 00:43Z, the release published its assets at
    // 02:03Z and the mirror's feed only carried 2.33.4 later still, so the drill spent its whole 45-minute
    // budget asking a feed that could not answer yet and failed with a sentence about the feed. The wait
    // therefore has to live outside the job that installs and launches the app — a macOS runner minute
    // costs ten ubuntu ones and has nothing to measure while it waits.
    const workflow = readWorkflow()
    const readiness = jobOf(workflow, 'readiness')
    expect(readiness['runs-on']).toBe('ubuntu-latest')

    const drill = jobOf(workflow, 'drill')
    expect(drill.needs).toBe('readiness')
    expect(readiness.outputs?.next_version).toBe('${{ steps.resolve.outputs.next_version }}')
    expect(readiness.outputs?.previous_tag).toBe('${{ steps.resolve.outputs.previous_tag }}')
  })

  it('drills the version the gate waited for, not one it resolved itself', () => {
    // A second resolution inside the drill job would be a second source of truth: the gate could wait for
    // 2.33.4 while the drill installs whatever `github.ref_name` happens to be.
    const drill = jobOf(readWorkflow(), 'drill')
    const drive = stepNamed(drill, 'Drive the upgrade')
    expect(drive.env?.NEXT_VERSION).toBe('${{ needs.readiness.outputs.next_version }}')
    expect(stepNamed(drill, 'Fetch the previous release').env?.PREVIOUS_TAG).toBe(
      '${{ needs.readiness.outputs.previous_tag }}'
    )
  })

  it('starts when the release is published, not when the tag is pushed', () => {
    // Measured on v2.33.6: tag pushed 19:32Z, assets published 23:41Z — 4 h 09, of which 2 h 32 was the
    // Release run queued for its first runner. The readiness job's 240-minute budget therefore gave up
    // nine minutes before the assets existed and reddened this lane on a healthy release (run
    // 45471232479). A budget cannot cover a queue delay nobody controls, so the lane starts at the event
    // that means "the assets are here".
    const triggers = readWorkflow().on as Record<string, unknown>
    expect(triggers).toHaveProperty('release')
    expect(JSON.stringify(triggers.release)).toContain('published')
    expect(triggers).not.toHaveProperty('push')
  })

  it('skips a pre-release tag by name instead of drilling it', () => {
    // `release: published` also fires for the nightly pre-release, whose tag is not a version. Without a
    // named skip the resolver would look for a previous release older than "nightly" and the drill would
    // ask the feed for a version nothing publishes.
    const resolve = stepNamed(jobOf(readWorkflow(), 'readiness'), 'Resolve the pair under test')
    const script = resolve.run ?? ''
    expect(resolve.env?.REF_NAME).toContain('github.event.release.tag_name')
    expect(script).toContain('"$EVENT_NAME" = "release"')
    expect(script).toContain("'${REF_NAME}' is not an x.y.z release tag")
  })

  it('waits on the release lane without anyone ticking a box', () => {
    // `inputs.require_feed_version` is a boolean, and `false || 'true'` evaluates to `'true'` — writing the
    // fallback that way would make the dispatch lane wait even when the operator turned it off, and make it
    // impossible to tell a deliberate opt-out from the automatic lane's default. The event decides first.
    const readiness = jobOf(readWorkflow(), 'readiness')
    const wait = stepNamed(readiness, 'Wait until the mirror offers it')
    const expression = wait.env?.WAIT_FOR_FEED ?? ''
    expect(expression).toContain("github.event_name == 'push'")
    expect(expression).toContain("github.event_name == 'release'")
    expect(expression).toContain('inputs.require_feed_version')
    expect(expression).not.toContain("inputs.require_feed_version || 'true'")
  })

  it('gives the wait more time than publishing plus one mirror sync, and the job more than the wait', () => {
    // Both numbers come from one release: tag 00:43Z -> assets 02:03Z (80 minutes), and the feed's own
    // `last-modified` for that version was 03:11Z (one hourly sync after the assets). A budget below that
    // sum is a gate that reddens on a healthy release; a job timeout below the budget cuts the wait short
    // and reports the runner's clock instead of the mirror's answer.
    const readiness = jobOf(readWorkflow(), 'readiness')
    const wait = stepNamed(readiness, 'Wait until the mirror offers it')
    const budgetMinutes = Number(wait.env?.BUDGET_MINUTES ?? '0')
    expect(budgetMinutes).toBeGreaterThanOrEqual(240)
    expect((readiness['timeout-minutes'] ?? 0) * 60).toBeGreaterThanOrEqual(budgetMinutes + 15)
  })

  it('keeps the drill job above the download ceiling it now allows', () => {
    // Measured on run 45521816671: the x64 drill was 97 % through the 312 MB transfer when a flat 900 s
    // budget cut it off. The wait is judged by progress now — 30 minutes of *movement* is the ceiling — so
    // the job bound has to stay above that ceiling plus unpack/install/relaunch, or the outer number comes
    // back as the thing that decides.
    const drill = jobOf(readWorkflow(), 'drill')
    const script = readDrillScript()
    const declared = /const DOWNLOAD_TIMEOUT_MS = ([\d_]+)/.exec(script)?.[1]
    expect(declared, 'the drill script no longer declares DOWNLOAD_TIMEOUT_MS').toBeDefined()
    const ceilingSeconds = Number(String(declared).replace(/_/g, '')) / 1000
    expect(ceilingSeconds).toBeGreaterThan(900)
    expect((drill['timeout-minutes'] ?? 0) * 60).toBeGreaterThan(ceilingSeconds + 45 * 60)
  })

  it('names a feed that is ahead instead of waiting for it to go backwards', () => {
    const wait = stepNamed(jobOf(readWorkflow(), 'readiness'), 'Wait until the mirror offers it')
    const script = wait.run ?? ''
    expect(script).toContain('newer than the target')
    expect(script).toContain(
      'did not offer ${NEXT_VERSION} with both mac zips within ${BUDGET_MINUTES} minutes'
    )
    // Both halves of the precondition: the version, and the two zips the tag lane drills off one wait.
    expect(script).toContain('-mac-arm64.zip')
    expect(script).toContain('-mac-x64.zip')
  })

  it('leaves the judgement to the drill, which keeps its own feed wait as the fallback', () => {
    // The gate decides when to start; it must not become the only reader of the feed. The drill still asks
    // the installed bundle's own updater and still names the wait it performed when the answer is wrong.
    const drive = stepNamed(jobOf(readWorkflow(), 'drill'), 'Drive the upgrade')
    expect(drive.run ?? '').toContain('scripts/macos-upgrade-certification.mjs')
    expect(drive.run ?? '').toContain('--next-version')
    expect(readDrillScript()).toContain('PURESCIENCE_DRILL_FEED_WAIT_MS')
  })
})
