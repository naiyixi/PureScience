import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  env?: Record<string, string>
  id?: string
  name?: string
  run?: string
}

type Workflow = {
  jobs: Record<string, { steps?: Step[] }>
}

const workflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8')
) as Workflow

const previousStep = (): Step => {
  const steps = workflow.jobs['windows-upgrade-smoke']?.steps ?? []
  const found = steps.find((step) => step.name === 'Download previous stable Windows installer')
  if (!found) throw new Error('Missing step: Download previous stable Windows installer')
  return found
}

describe('release workflow · Windows upgrade drill', () => {
  /**
   * Why this is pinned: the step drops "the version being published" from the list of stable releases
   * and takes the first one left. A dispatch that publishes an already-created tag runs with
   * `github.ref_name` = `main`, so an exclusion written against the ref matches nothing: the release
   * this very run created is fetched as "previous", both directories hold the same version, and the
   * certification fails with `Updater certification needs two versions` — a red that reads like a
   * product defect while the drill's own install / rollback / restart steps passed (measured on the
   * v2.21.0 publish). The published tag is the value that keeps the exclusion meaningful in both
   * shapes: a tag run publishes the tag it was pushed for, a dispatch publishes the tag it names.
   */
  it('excludes the published tag, not the ref the run started from', () => {
    expect(previousStep().env?.CURRENT_TAG).toBe('${{ inputs.release_tag || github.ref_name }}')
  })

  /**
   * The second half of the same instrument: when the drill does go red, the log has to say which two
   * versions it compared. Without that line "the updater broke" and "the wrong two versions were
   * fetched" print the same sentence.
   */
  it('names the pair it compares, so a red here can be read as a fetch problem', () => {
    expect(previousStep().run).toContain('previous stable = $tag; publishing = $env:CURRENT_TAG')
  })
})
