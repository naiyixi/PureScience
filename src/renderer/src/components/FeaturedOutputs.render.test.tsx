// @vitest-environment jsdom
// What a finished remote job produced. The result payload has carried featured outputs, the files left on
// the remote host and a failed-harvest error since Phase 3b, and no surface read any of it — this pins what
// the reader now sees, including the two states that must not read as "this is everything": a payload that
// reports more left-behind files than it lists, and a harvest that failed with the workdir still kept.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { JobSummary } from '../../../shared/compute'

const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-abc',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  status: 'running',
  intent: 'Run EDA analysis',
  created_at: Date.now(),
  started_at: Date.now(),
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: '/home/user/.purescience/jobs/job-abc',
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})

let container: HTMLDivElement
let root: Root

const render = async (job: JobSummary): Promise<void> => {
  const { FeaturedOutputs } = await import('./FeaturedOutputs')
  act(() => {
    root.render(<FeaturedOutputs job={job} />)
  })
}

const testId = (id: string): Element | null => container.querySelector(`[data-testid="${id}"]`)

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('FeaturedOutputs', () => {
  it('lists the featured files and every file left behind with its own reason', async () => {
    await render(
      makeJob({
        featured_files: ['hpc/job-abc/featured/out.result', 'hpc/job-abc/featured/plot.png'],
        featured_file_count: 2,
        left_on_remote: [
          { uri: 's3://bucket/reads.bam', size_mb: 1_204, reason: 'exceeds_size_limit' }
        ],
        left_on_remote_count: 1
      })
    )

    const featured = testId('featured-output-files')
    expect(featured?.textContent ?? '').toContain('hpc/job-abc/featured/out.result')
    expect(featured?.textContent ?? '').toContain('hpc/job-abc/featured/plot.png')

    const left = testId('left-on-remote-files')
    expect(left?.textContent ?? '').toContain('s3://bucket/reads.bam')
    // The reason travels WITH the file: a bare list of paths a reader cannot act on.
    expect(left?.textContent ?? '').toContain('exceeds_size_limit')
    expect(left?.textContent ?? '').toContain('1204')

    expect(testId('featured-output-count')?.textContent ?? '').toContain('2')
    expect(testId('left-on-remote-count')?.textContent ?? '').toContain('1')
    // Counts agree with the list, so nothing is claimed to be missing.
    expect(testId('left-on-remote-not-listed')).toBeNull()
    expect(testId('harvest-failed')).toBeNull()
  })

  it('says so when the payload reports more left-behind files than it lists', async () => {
    await render(
      makeJob({
        featured_files: [],
        featured_file_count: 0,
        left_on_remote: [{ uri: 's3://bucket/a.bam', size_mb: 900, reason: 'too_large' }],
        left_on_remote_count: 5
      })
    )

    // Four of the five are not in the payload: showing one silently would read as "one file stayed".
    const notListed = testId('left-on-remote-not-listed')
    expect(notListed).not.toBeNull()
    expect(notListed?.textContent ?? '').toContain('4')
    expect(testId('left-on-remote-count')?.textContent ?? '').toContain('5')
  })

  it('names a failed harvest and keeps the workdir beside it, because that is the way to the files', async () => {
    await render(
      makeJob({
        harvest_error: 'rsync exited with code 23',
        remote_workdir: '/scratch/biowulf/job-abc',
        left_on_remote: [],
        left_on_remote_count: 0,
        featured_files: [],
        featured_file_count: 0
      })
    )

    expect(testId('harvest-failed')).not.toBeNull()
    expect(testId('harvest-error')?.textContent ?? '').toContain('rsync exited with code 23')
    expect(testId('harvest-error-workdir')?.textContent ?? '').toContain('/scratch/biowulf/job-abc')
  })

  it('stays out of the way when the result carried no harvest data at all', async () => {
    await render(makeJob({ status: 'running' }))

    expect(testId('featured-outputs')).toBeNull()
  })
})
