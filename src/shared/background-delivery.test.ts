import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_DELIVERY_CONSUMABLE_STATES,
  BACKGROUND_DELIVERY_HASH_RECIPE,
  BACKGROUND_DELIVERY_SCHEMA_VERSION,
  BACKGROUND_DELIVERY_STATES,
  buildBackgroundDeliveryContinuation,
  formatBackgroundDeliveryLine,
  isBackgroundDeliveryClaimLive,
  isBackgroundDeliveryConsumable,
  type BackgroundDelivery,
  type BackgroundDeliveryLabels,
  type BackgroundDeliveryReason,
  type BackgroundDeliveryState
} from './background-delivery'

const REASONS: readonly BackgroundDeliveryReason[] = [
  'job-not-found',
  'session-mismatch',
  'not-consumable',
  'claim-held',
  'result-unreadable'
]

const labels = (header = 'Delivery'): BackgroundDeliveryLabels => ({
  header,
  state: 'State',
  stateNames: Object.fromEntries(
    BACKGROUND_DELIVERY_STATES.map((state) => [state, `label:${state}`])
  ) as Record<BackgroundDeliveryState, string>,
  job: 'Job',
  files: 'Files',
  fingerprint: 'Fingerprint',
  reason: 'Reason',
  reasonNames: Object.fromEntries(REASONS.map((reason) => [reason, `reason:${reason}`])) as Record<
    BackgroundDeliveryReason,
    string
  >,
  continuation: 'A background job has finished.',
  noResult: 'No result'
})

const delivery = (overrides: Partial<BackgroundDelivery> = {}): BackgroundDelivery => ({
  schemaVersion: BACKGROUND_DELIVERY_SCHEMA_VERSION,
  id: 'delivery-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  jobId: 'job-77',
  sourceKind: 'compute',
  state: 'pending',
  outputFiles: ['hpc/job-77/featured/out.csv'],
  fingerprint: 'sha256:abc123',
  claimToken: undefined,
  claimExpiresAt: undefined,
  continuationMessageId: undefined,
  reason: undefined,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  consumedAt: undefined,
  ...overrides
})

describe('background delivery contract', () => {
  it('publishes a recipe name for recomputing a delivery fingerprint', () => {
    expect(BACKGROUND_DELIVERY_HASH_RECIPE).toBe('purescience-background-delivery-v1')
  })

  it('names every state, so the ledger cannot hold an unnamed one', () => {
    expect(BACKGROUND_DELIVERY_STATES).toEqual([
      'waiting-result',
      'pending',
      'claimed',
      'dispatching',
      'consumed',
      'needs-attention'
    ])
    // The label record is exhaustive by type; this pins the runtime list to it.
    expect(Object.keys(labels().stateNames).sort()).toEqual([...BACKGROUND_DELIVERY_STATES].sort())
  })

  it('treats a claim as live only while its lease holds', () => {
    const live = { claimToken: 'token-1', claimExpiresAt: 2_000 }
    expect(isBackgroundDeliveryClaimLive(live, 1_999)).toBe(true)
    // The boundary matters: a lease that expires exactly now is nobody's, so a crashed worker can be
    // taken over instead of stranding the delivery forever.
    expect(isBackgroundDeliveryClaimLive(live, 2_000)).toBe(false)
    expect(isBackgroundDeliveryClaimLive(live, 2_001)).toBe(false)
    expect(isBackgroundDeliveryClaimLive({ claimToken: undefined, claimExpiresAt: 2_000 }, 0)).toBe(
      false
    )
    expect(
      isBackgroundDeliveryClaimLive({ claimToken: 'token-1', claimExpiresAt: undefined }, 0)
    ).toBe(false)
  })

  it('lets only deliveries with something to deliver be consumed', () => {
    expect(BACKGROUND_DELIVERY_CONSUMABLE_STATES).toEqual([
      'pending',
      'claimed',
      'dispatching',
      'needs-attention'
    ])
    for (const state of BACKGROUND_DELIVERY_STATES) {
      expect(isBackgroundDeliveryConsumable(delivery({ state }))).toBe(
        BACKGROUND_DELIVERY_CONSUMABLE_STATES.includes(state)
      )
    }
    // A delivery whose result never arrived is not consumable, and one already consumed is terminal.
    expect(isBackgroundDeliveryConsumable(delivery({ state: 'waiting-result' }))).toBe(false)
    expect(isBackgroundDeliveryConsumable(delivery({ state: 'consumed' }))).toBe(false)
  })
})

describe('formatBackgroundDeliveryLine', () => {
  it('keeps ids, paths and the fingerprint untranslated', () => {
    const english = formatBackgroundDeliveryLine(delivery(), labels('Delivery'))
    const chinese = formatBackgroundDeliveryLine(delivery(), labels('投递'))

    expect(english).toContain('delivery-1')
    expect(chinese).toContain('delivery-1')
    expect(english).toContain('hpc/job-77/featured/out.csv')
    expect(chinese).toContain('hpc/job-77/featured/out.csv')
    expect(english).toContain('sha256:abc123')
    expect(chinese).toContain('sha256:abc123')
    // Only the labels move with the language.
    expect(english.startsWith('Delivery:')).toBe(true)
    expect(chinese.startsWith('投递:')).toBe(true)
  })

  it('shows the named reason only when there is one', () => {
    const plain = formatBackgroundDeliveryLine(delivery(), labels())
    expect(plain).not.toContain('reason:')

    const blocked = formatBackgroundDeliveryLine(
      delivery({ state: 'needs-attention', reason: 'result-unreadable' }),
      labels()
    )
    expect(blocked).toContain('label:needs-attention')
    expect(blocked).toContain('reason:result-unreadable')
  })

  it('says so instead of inventing a value when files or fingerprint are missing', () => {
    const empty = formatBackgroundDeliveryLine(
      delivery({ state: 'waiting-result', outputFiles: [], fingerprint: undefined }),
      labels()
    )
    expect(empty).toContain('Files: —')
    expect(empty).toContain('Fingerprint: —')
  })
})

describe('buildBackgroundDeliveryContinuation', () => {
  it('lists deliverable results with their files and fingerprints', () => {
    const text = buildBackgroundDeliveryContinuation([delivery()], labels())

    expect(text.split('\n')[0]).toBe('A background job has finished.')
    expect(text).toContain('job-77')
    expect(text).toContain('hpc/job-77/featured/out.csv')
    expect(text).toContain('sha256:abc123')
    expect(text).not.toContain('No result')
  })

  it('states an undeliverable result as missing, with its reason, instead of analysing it', () => {
    const text = buildBackgroundDeliveryContinuation(
      [
        delivery({
          state: 'needs-attention',
          reason: 'result-unreadable',
          outputFiles: [],
          fingerprint: undefined
        })
      ],
      labels()
    )

    expect(text).toContain('No result')
    expect(text).toContain('reason:result-unreadable')
    expect(text).not.toContain('sha256:')
  })

  it('keeps both voices when one result landed and another did not', () => {
    const text = buildBackgroundDeliveryContinuation(
      [
        delivery(),
        delivery({
          id: 'delivery-2',
          jobId: 'job-78',
          state: 'needs-attention',
          reason: 'result-unreadable',
          outputFiles: [],
          fingerprint: undefined
        })
      ],
      labels()
    )

    // Count the block openers only: a path line mentions the job id too, which is not a second block.
    const lines = text.split('\n')
    const openers = lines.filter((line) => line.startsWith('- '))
    expect(openers.filter((line) => line.includes('job-77'))).toHaveLength(1)
    expect(openers.filter((line) => line.includes('job-78'))).toHaveLength(1)
    expect(openers).toHaveLength(2)
    expect(text).toContain('sha256:abc123')
    expect(text).toContain('reason:result-unreadable')
  })
})
