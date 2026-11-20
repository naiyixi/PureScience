import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  env?: Record<string, string>
  name?: string
  run?: string
  'timeout-minutes'?: number
}
type Workflow = {
  jobs?: Record<
    string,
    { env?: Record<string, string>; steps?: Step[]; 'timeout-minutes'?: number } | undefined
  >
  on?: unknown
}

const readWorkflow = (): Workflow =>
  load(
    readFileSync(join(process.cwd(), '.github/workflows/update-drill-macos.yml'), 'utf8')
  ) as Workflow

const readDrillScript = (): string =>
  readFileSync(join(process.cwd(), 'scripts/macos-update-cache-drill.mjs'), 'utf8')

const drillJob = (): NonNullable<Workflow['jobs']>[string] => {
  const job = readWorkflow().jobs?.macos_update_drill
  expect(job).toBeDefined()
  return job
}

const drillStep = (): Step => {
  const step = (drillJob()?.steps ?? []).find((candidate) =>
    candidate.run?.includes('scripts/macos-update-cache-drill.mjs')
  )
  expect(step).toBeDefined()
  return step as Step
}

describe('macOS update drill workflow', () => {
  it('hands the drill the team id it refuses to run without', () => {
    // The drill stops by name when PURESCIENCE_MAC_TEAM_ID is unset ("an unattributable signature is
    // not a pass"), which means an unwired workflow can never pass this gate — and a gate that cannot
    // pass reads exactly like a broken product. The value must come from the repository variable, not
    // a literal, so the same number is used by the drill, the notarize job and the release gate.
    const jobEnv = drillJob()?.env ?? {}
    const stepEnv = drillStep().env ?? {}
    expect(jobEnv.PURESCIENCE_MAC_TEAM_ID ?? stepEnv.PURESCIENCE_MAC_TEAM_ID).toBe(
      '${{ vars.PURESCIENCE_MAC_TEAM_ID }}'
    )
  })

  it('reads the same variable name on both sides of the hand-off', () => {
    // A rename on either side (workflow env vs. the drill's lookup) would silently disable the
    // signature comparison rather than fail, so the name itself is part of the contract.
    expect(readDrillScript()).toContain('PURESCIENCE_MAC_TEAM_ID')
  })

  it('actually performs the real in-place update', () => {
    // Without --real-update the drill exercises the feed only; the shipped hand-off (quit → Squirrel.Mac
    // replaces the bundle → new version launches → package purged) is the thing being certified.
    expect(drillStep().run).toContain('--real-update')
  })

  it('cannot pass without printing its verdict', () => {
    // The verdict line is a contract on both sides: the script prints it, the workflow greps it.
    const steps = drillJob()?.steps ?? []
    const confirm = steps.find((step) => step.run?.includes('macos update drill: ok '))
    expect(confirm).toBeDefined()
    expect(readDrillScript()).toContain('macos update drill: ok ')
  })

  it('cross-checks the app own purge record instead of trusting an empty directory', () => {
    // An emptied cache directory proves the bytes are gone, not who removed them: the directory the
    // drill watches is inferred from app-update.yml, and `require('electron-updater')` is not
    // resolvable inside a packaged bundle. The app's own record is the only authority available, so
    // the drill must consult it and stop by name when it is missing or disagrees.
    const script = readDrillScript()
    expect(script).toContain("step = 'cross-check-the-app-purge-record'")
    expect(script).toContain('readAppUpdateCacheRecords({ home })')
    expect(script).toContain('if (!purgeVerdict.ok) throw new Error(purgeVerdict.reason)')
    // The byte the app must remove is the cache as it stands when the install actually starts — asking
    // the app to apply writes the install-pending marker (+61 bytes) after the download snapshot, so
    // comparing against the pre-apply count is off by exactly that marker.
    expect(script).toContain('const cacheAtQuit = await snapshotDirectory(cacheDir)')
    expect(script).toContain('expectedBytes: cacheAtQuit.bytes')
  })

  it('gates on the app own cache-dir resolution instead of an unjudged probe', () => {
    // `require('electron-updater')` never resolves inside a packaged bundle, so the old probe answered
    // "unavailable" on every real run and nothing compared that string — a cross-check in the comments
    // only. The reading that does exist is the app's hand-off record (written before quitAndInstall),
    // and it must stop the drill by name when it names another directory or is missing altogether.
    const script = readDrillScript()
    expect(script).toContain("step = 'verify-the-app-resolved-the-cache-under-test'")
    expect(script).toContain('if (!resolution.ok) throw new Error(resolution.reason)')
    expect(script).toContain('selectHandoffRecord')
    expect(script).not.toContain('readUpdaterCacheDirFromApp')
  })

  it('stays a bounded, on-demand gate', () => {
    // Manual only on purpose: two ~150 MB installers and a real install, so it is a release-time gate.
    const on = readWorkflow().on as Record<string, unknown> | undefined
    expect(on).toHaveProperty('workflow_dispatch')
    expect(drillJob()?.['timeout-minutes']).toBeGreaterThan(0)
    expect(drillStep()['timeout-minutes']).toBeGreaterThan(0)
  })
})
