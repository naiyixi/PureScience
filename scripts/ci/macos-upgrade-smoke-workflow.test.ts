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

  it('waits on the tag lane without anyone ticking a box', () => {
    // `inputs.require_feed_version` is a boolean, and `false || 'true'` evaluates to `'true'` — writing the
    // fallback that way would make the dispatch lane wait even when the operator turned it off, and make it
    // impossible to tell a deliberate opt-out from the tag lane's default. The event has to decide first.
    const readiness = jobOf(readWorkflow(), 'readiness')
    const wait = stepNamed(readiness, 'Wait until the mirror offers it')
    const expression = wait.env?.WAIT_FOR_FEED ?? ''
    expect(expression).toContain("github.event_name == 'push'")
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
