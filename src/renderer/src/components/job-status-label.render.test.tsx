// @vitest-environment jsdom
// The two job surfaces in a conversation — the timeline card and the detail header — used to spell their
// status with English literals of their own ('finished', 'DONE', 'TIMED OUT'), so a reader on a Chinese
// interface saw English words beside fully translated labels. This pins the wording they now ask for
// (per status, two languages) and pins the single place that decides it, because the original defect was
// two components each deciding for themselves.
import { readFileSync } from 'node:fs'

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  COMPUTE_JOB_STATUSES,
  type ComputeJobStatus,
  type JobSummary
} from '../../../shared/compute'
import { LanguageProvider } from '@/i18n'
import { en } from '@/i18n/en'
import { zh } from '@/i18n/zh'
import { CompletedJobCard } from './CompletedJobCard'
import { JobStatusBadge } from './JobStatusBadge'
import { JOB_STATUS_I18N_KEYS } from './job-status-label'

let container: HTMLDivElement | null = null
let root: Root | null = null

const renderWith = (language: 'en' | 'zh', node: ReactNode): HTMLElement => {
  // The provider reads its preference once, when it mounts — so each case gets a fresh root instead of
  // re-rendering an already-mounted provider and expecting a language switch.
  window.localStorage.setItem('purescience-language', language)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<LanguageProvider>{node}</LanguageProvider>)
  })
  return container
}

const badgeText = (mountPoint: HTMLElement): string =>
  mountPoint.querySelector('[data-testid="job-status-badge"]')?.textContent ?? ''

const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-abc',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  status: 'success',
  intent: 'Run EDA analysis',
  created_at: 1_700_000_000_000,
  started_at: 1_700_000_000_000,
  finished_at: 1_700_000_100_000,
  exit_code: 0,
  error_code: undefined,
  remote_workdir: '/home/user/.purescience/jobs/job-abc',
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('job status wording', () => {
  it.each(COMPUTE_JOB_STATUSES)('the badge says the Chinese word for %s', (status) => {
    const key = JOB_STATUS_I18N_KEYS[status as ComputeJobStatus]
    const mountPoint = renderWith('zh', <JobStatusBadge status={status as ComputeJobStatus} />)
    const text = badgeText(mountPoint)
    expect(text).toBe(zh[key])
    // The point of the change: a translated interface must not print the English word.
    expect(text).not.toBe(en[key])
  })

  it.each(COMPUTE_JOB_STATUSES)('the badge still says the English word for %s', (status) => {
    const key = JOB_STATUS_I18N_KEYS[status as ComputeJobStatus]
    const mountPoint = renderWith('en', <JobStatusBadge status={status as ComputeJobStatus} />)
    expect(badgeText(mountPoint)).toBe(en[key])
  })

  it('the conversation card names the status in the interface language', () => {
    const mountPoint = renderWith('zh', <CompletedJobCard job={makeJob()} onOpen={() => {}} />)
    const card = mountPoint.querySelector('[data-testid="completed-job-card"]')
    expect(card?.textContent).toContain(`— ${zh['jobStatus.success']}`)
    expect(card?.textContent).not.toContain('finished')
  })

  it('a cancelled job is named as such, not as a failure', () => {
    const mountPoint = renderWith(
      'zh',
      <CompletedJobCard job={makeJob({ status: 'cancelled' })} onOpen={() => {}} />
    )
    const card = mountPoint.querySelector('[data-testid="completed-job-card"]')
    expect(card?.textContent).toContain(`— ${zh['jobStatus.cancelled']}`)
    expect(card?.textContent).not.toContain(zh['jobStatus.failed'])
  })

  it('every status in the closed list resolves to a key both dictionaries hold', () => {
    const missing = COMPUTE_JOB_STATUSES.filter((status) => {
      const key = JOB_STATUS_I18N_KEYS[status]
      return !key || !(key in en) || !(key in zh)
    })
    expect(missing).toEqual([])
  })
})

describe('no component spells the status itself', () => {
  // The defect was a literal inside a component, so the guard reads the components. Both files are read
  // unconditionally — a scan that silently found no file would pass while proving nothing.
  const FILES = ['./JobStatusBadge.tsx', './CompletedJobCard.tsx', './RemoteJobRow.tsx']
  const sources = FILES.map((relative) => ({
    file: relative,
    text: readFileSync(new URL(relative, import.meta.url), 'utf8')
  }))

  it('reads every component that names a status', () => {
    expect(sources).toHaveLength(FILES.length)
    for (const source of sources) expect(source.text.length).toBeGreaterThan(500)
  })

  it('holds none of the English status words as a string literal', () => {
    const englishWords = [...new Set(Object.values(JOB_STATUS_I18N_KEYS).map((key) => en[key]))]
    const offenders = sources.flatMap((source) =>
      englishWords
        .filter((word) => source.text.includes(`'${word}'`))
        .map((word) => `${source.file}: '${word}'`)
    )
    expect(offenders).toEqual([])
  })
})
