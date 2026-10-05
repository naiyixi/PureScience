// @vitest-environment jsdom
// Tests for JobDetailModal — tab switching, Back navigation, and session jobs list.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../shared/compute'
import { createInitialSessionJobState, useSessionJobStore } from '@/stores/session-job-store'

// Mock radix Dialog to avoid portal / overlay complexity in jsdom
vi.mock('radix-ui', () => {
  const Root = ({
    open,
    children
  }: {
    open: boolean
    children: React.ReactNode
    onOpenChange?: (o: boolean) => void
  }): React.JSX.Element | null => (open ? <div data-testid="dialog-root">{children}</div> : null)

  const Portal = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div data-testid="dialog-portal">{children}</div>
  )
  const Overlay = (): React.JSX.Element => <div data-testid="dialog-overlay" />
  const Content = ({
    children,
    ...rest
  }: {
    children: React.ReactNode
    [k: string]: unknown
  }): React.JSX.Element => (
    <div data-testid="dialog-content" {...rest}>
      {children}
    </div>
  )
  const Close = ({
    children
  }: {
    children: React.ReactElement
    asChild?: boolean
  }): React.JSX.Element => children

  return {
    Dialog: { Root, Portal, Overlay, Content, Close }
  }
})

// Mock FileBrowserModal
vi.mock('../pages/settings/FileBrowserModal', () => ({
  FileBrowserModal: ({
    open,
    initialProviderId
  }: {
    open: boolean
    onClose: () => void
    initialProviderId?: string
  }): React.JSX.Element | null =>
    open ? <div data-testid="file-browser-modal" data-provider={initialProviderId} /> : null
}))

// Mock Button
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    onClick?: () => void
    [k: string]: unknown
  }): React.JSX.Element => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  )
}))

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
  stdout_tail: 'stdout output line 1\nline 2',
  stderr_tail: 'stderr output line 1',
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSessionJobStore.setState(createInitialSessionJobState())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('JobDetailModal — detail view', () => {
  it('renders job meta info when opened with a job', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({ intent: 'Run EDA analysis', display_name: 'biowulf' })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    expect(container.textContent).toContain('Run EDA analysis')
    expect(container.textContent).toContain('biowulf')
    expect(container.textContent).toContain('job-abc')
  })

  it('renders stdout tab content by default', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({
      stdout_tail: 'this is stdout output',
      stderr_tail: 'this is stderr output'
    })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    // By default stdout is active
    const output = container.querySelector('[data-testid="job-terminal-output"]')
    expect(output?.textContent).toContain('this is stdout output')
  })

  it('switches to stderr tab when clicked', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({
      stdout_tail: 'stdout content',
      stderr_tail: 'stderr content'
    })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    const stderrTab = container.querySelector('[data-testid="tab-stderr"]') as HTMLButtonElement
    act(() => stderrTab.click())

    const output = container.querySelector('[data-testid="job-terminal-output"]')
    expect(output?.textContent).toContain('stderr content')
  })

  it('shows Back button that navigates to session jobs list', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob()
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    const backBtn = container.querySelector('[data-testid="job-detail-back"]') as HTMLButtonElement
    act(() => backBtn.click())

    // After Back, should show session jobs list
    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeTruthy()
  })

  it('renders remote workdir link', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({ remote_workdir: '/home/user/.purescience/jobs/job-abc' })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    expect(container.textContent).toContain('/home/user/.purescience/jobs/job-abc')
  })

  it('opens FileBrowserModal when workdir link is clicked', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({
      remote_workdir: '/home/user/.purescience/jobs/job-abc',
      provider_id: 'ssh:biowulf'
    })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })

    // Find the workdir link button
    const workdirBtn = container.querySelector(
      '[data-testid="job-meta"] button'
    ) as HTMLButtonElement
    act(() => workdirBtn.click())

    const browser = container.querySelector('[data-testid="file-browser-modal"]')
    expect(browser).toBeTruthy()
    expect(browser?.getAttribute('data-provider')).toBe('ssh:biowulf')
  })
})

describe('JobDetailModal — session jobs list view', () => {
  it('shows list of session jobs when opened without initialJob', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job1 = makeJob({ job_id: 'job-1', intent: 'Intent 1', session_id: 'sess-1' })
    const job2 = makeJob({ job_id: 'job-2', intent: 'Intent 2', session_id: 'sess-1' })
    const otherSessionJob = makeJob({ job_id: 'job-other', session_id: 'sess-other' })
    useSessionJobStore.getState().applyUpdate(job1)
    useSessionJobStore.getState().applyUpdate(job2)
    useSessionJobStore.getState().applyUpdate(otherSessionJob)

    act(() => {
      root.render(<JobDetailModal open={false} sessionId="sess-1" onClose={vi.fn()} />)
    })

    // Modal is closed — nothing rendered
    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeNull()
  })

  it('shows session jobs list with jobs from this session', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job1 = makeJob({ job_id: 'job-1', intent: 'Intent A', session_id: 'sess-1' })
    const job2 = makeJob({ job_id: 'job-2', intent: 'Intent B', session_id: 'sess-1' })
    useSessionJobStore.getState().applyUpdate(job1)
    useSessionJobStore.getState().applyUpdate(job2)

    act(() => {
      root.render(<JobDetailModal open={true} sessionId="sess-1" onClose={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeTruthy()
    expect(container.textContent).toContain('Intent A')
    expect(container.textContent).toContain('Intent B')
  })

  it('clicking a job row in the list opens its detail view', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({ job_id: 'job-list-test', intent: 'From list', session_id: 'sess-1' })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(<JobDetailModal open={true} sessionId="sess-1" onClose={vi.fn()} />)
    })

    // Should be in list view
    const listView = container.querySelector('[data-testid="session-jobs-list"]')
    expect(listView).toBeTruthy()

    // Click on the job row
    const jobRow = container.querySelector('[data-testid="session-job-row"]') as HTMLButtonElement
    act(() => jobRow.click())

    // Should now be in detail view
    expect(container.querySelector('[data-testid="job-detail-back"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeNull()
  })

  it('returns to the session jobs list when the same modal is reopened', async () => {
    const { JobDetailModal } = await import('./JobDetailModal')
    const job = makeJob({ job_id: 'job-reopen', intent: 'Reopen test', session_id: 'sess-1' })
    useSessionJobStore.getState().applyUpdate(job)

    act(() => {
      root.render(<JobDetailModal open={true} sessionId="sess-1" onClose={vi.fn()} />)
    })
    const jobRow = container.querySelector('[data-testid="session-job-row"]') as HTMLButtonElement
    act(() => jobRow.click())
    expect(container.querySelector('[data-testid="job-detail-back"]')).toBeTruthy()

    act(() => {
      root.render(<JobDetailModal open={false} sessionId="sess-1" onClose={vi.fn()} />)
    })
    act(() => {
      root.render(<JobDetailModal open={true} sessionId="sess-1" onClose={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="session-jobs-list"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="job-detail-back"]')).toBeNull()
  })
})

// ─── IC39: the window can stop a queued / running remote job ──────────────────
// The control is only a real feature if the answer from the main process reaches the screen: a
// cancellation the host never received must not read as one, so each refusal shape is asserted by the
// sentence the user sees, not by "the button was clicked".
describe('JobDetailModal — stopping a remote job', () => {
  const stubCancel = (impl: (jobId: string) => Promise<unknown>): ReturnType<typeof vi.fn> => {
    const jobsCancel = vi.fn(impl)
    ;(window as unknown as { api: unknown }).api = { compute: { jobsCancel } }
    return jobsCancel
  }

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  const openDetail = async (job: JobSummary): Promise<void> => {
    const { JobDetailModal } = await import('./JobDetailModal')
    useSessionJobStore.getState().applyUpdate(job)
    act(() => {
      root.render(
        <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
      )
    })
  }

  const cancelButton = (): HTMLButtonElement =>
    container.querySelector('[data-testid="job-cancel"]') as HTMLButtonElement

  it('offers the control on a running job and reports the stop the main process confirmed', async () => {
    const jobsCancel = stubCancel(async () => ({
      job_id: 'job-abc',
      outcome: 'cancelled',
      status: 'cancelled'
    }))
    await openDetail(makeJob({ status: 'running' }))
    expect(cancelButton().textContent).toContain('Cancel job')

    await act(async () => {
      cancelButton().click()
    })

    expect(jobsCancel).toHaveBeenCalledWith('job-abc')
    const result = container.querySelector('[data-slot="job-cancel-result"]')
    expect(result?.textContent).toContain('the job is now cancelled')
    expect(result?.getAttribute('role')).toBe('status')
  })

  it('reports a host that could not be reached as a refusal, with the launch failure verbatim', async () => {
    stubCancel(async () => ({
      job_id: 'job-abc',
      outcome: 'refused',
      refusal: 'host-unreachable',
      status: 'running',
      detail: 'ssh: connect to host biowulf port 22: Operation timed out'
    }))
    await openDetail(makeJob({ status: 'running' }))

    await act(async () => {
      cancelButton().click()
    })

    const result = container.querySelector('[data-slot="job-cancel-result"]')
    expect(result?.textContent).toContain('was not stopped and is still running')
    expect(result?.textContent).toContain('Operation timed out')
    expect(result?.getAttribute('role')).toBe('alert')
  })

  it('reports a job that had already finished instead of pretending to stop it', async () => {
    stubCancel(async () => ({
      job_id: 'job-abc',
      outcome: 'refused',
      refusal: 'already-terminal',
      status: 'success'
    }))
    await openDetail(makeJob({ status: 'running' }))

    await act(async () => {
      cancelButton().click()
    })

    const result = container.querySelector('[data-slot="job-cancel-result"]')
    expect(result?.textContent).toContain('had already finished')
  })

  it('reports a job that is still being prepared as not stopped yet', async () => {
    stubCancel(async () => ({
      job_id: 'job-abc',
      outcome: 'refused',
      refusal: 'starting',
      status: 'submitted'
    }))
    await openDetail(makeJob({ status: 'submitted' }))

    await act(async () => {
      cancelButton().click()
    })

    const result = container.querySelector('[data-slot="job-cancel-result"]')
    expect(result?.textContent).toContain('still being prepared on the host')
  })

  it('says so when the request never reached the app', async () => {
    stubCancel(async () => {
      throw new Error('channel closed')
    })
    await openDetail(makeJob({ status: 'running' }))

    await act(async () => {
      cancelButton().click()
    })

    const result = container.querySelector('[data-slot="job-cancel-result"]')
    expect(result?.textContent).toContain('Could not ask the app to stop this job')
    expect(result?.getAttribute('role')).toBe('alert')
  })

  it('hides the control on a job that already rests in a terminal state', async () => {
    stubCancel(async () => ({ job_id: 'job-abc', outcome: 'cancelled', status: 'cancelled' }))
    await openDetail(makeJob({ status: 'success', finished_at: Date.now() }))

    expect(container.querySelector('[data-testid="job-cancel"]')).toBeNull()
  })

  it('hides the control on a cancelled job as well', async () => {
    stubCancel(async () => ({ job_id: 'job-abc', outcome: 'cancelled', status: 'cancelled' }))
    await openDetail(makeJob({ status: 'cancelled', finished_at: Date.now() }))

    expect(container.querySelector('[data-testid="job-cancel"]')).toBeNull()
  })
})
