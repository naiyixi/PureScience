// @vitest-environment jsdom
// The job-detail delivery ledger: what it shows for a delivered result, for a blocked one, and when
// the main process has no record at all.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackgroundDelivery } from '../../../shared/background-delivery'

const makeDelivery = (overrides: Partial<BackgroundDelivery> = {}): BackgroundDelivery => ({
  schemaVersion: 1,
  id: 'del-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  jobId: 'job-abc',
  sourceKind: 'compute',
  state: 'consumed',
  outputFiles: ['results/table.tsv'],
  fingerprint: 'sha256:abc123',
  claimToken: undefined,
  claimExpiresAt: undefined,
  continuationMessageId: 'msg-9',
  reason: undefined,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
  consumedAt: 1_700_000_060_000,
  ...overrides
})

let container: HTMLDivElement
let root: Root

const mount = async (deliveries: BackgroundDelivery[]): Promise<void> => {
  const { JobDeliveryLedger } = await import('./JobDeliveryLedger')
  act(() => {
    root.render(<JobDeliveryLedger sessionId="sess-1" jobId="job-abc" />)
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(deliveries).toBeDefined()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const withLedger = (deliveries: BackgroundDelivery[]): void => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { compute: { deliveriesList: vi.fn().mockResolvedValue(deliveries) } }
  })
}

describe('JobDeliveryLedger', () => {
  it('shows the delivery: state, job, trigger, fingerprint and files', async () => {
    withLedger([makeDelivery()])
    await mount([])

    const ledger = container.querySelector('[data-testid="job-delivery-ledger"]')
    expect(ledger).not.toBeNull()
    const text = ledger?.textContent ?? ''
    expect(text).toContain('Background result delivery')
    expect(text).toContain('delivered')
    expect(text).toContain('job-abc')
    expect(text).toContain('compute')
    expect(text).toContain('sha256:abc123')
    expect(text).toContain('results/table.tsv')
    expect(container.querySelector('[data-testid="job-delivery-copy"]')?.textContent).toBe(
      'Copy delivery details'
    )
  })

  // The anti-shell case: a delivery that could not be read must say so rather than look delivered.
  it('names the reason a delivery needs attention instead of looking delivered', async () => {
    withLedger([
      makeDelivery({
        state: 'needs-attention',
        reason: 'result-unreadable',
        fingerprint: undefined
      })
    ])
    await mount([])

    expect(container.querySelector('[data-testid="job-delivery-state"]')?.textContent).toBe(
      'needs attention'
    )
    expect(container.querySelector('[data-testid="job-delivery-reason"]')?.textContent).toBe(
      'the result could not be read'
    )
  })

  it('renders nothing for a job the ledger does not know about', async () => {
    withLedger([makeDelivery({ jobId: 'other-job' })])
    await mount([])

    expect(container.querySelector('[data-testid="job-delivery-ledger"]')).toBeNull()
  })

  it('renders nothing when the ledger cannot be read', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { compute: { deliveriesList: vi.fn().mockRejectedValue(new Error('no ledger')) } }
    })
    await mount([])

    expect(container.querySelector('[data-testid="job-delivery-ledger"]')).toBeNull()
  })
})
