// @vitest-environment jsdom
// The human-pinned evidence section of a review card: what a person pinned, apart from what the model
// claimed — listed with the query that found it and the fingerprint that makes it checkable.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HumanEvidenceSection } from './HumanEvidenceSection'
import type { ReviewEvidenceAttachment } from '../../../shared/review-evidence'

const attachment: ReviewEvidenceAttachment = {
  schemaVersion: 1,
  id: 'pin-1',
  reviewId: 'review-1',
  projectId: 'project-a',
  sessionId: 'session-a',
  messageId: 'message-2',
  role: 'agent',
  fingerprint: `sha256:${'a'.repeat(64)}`,
  query: 'sin csv',
  terms: ['sin', 'csv'],
  snippet: 'wrote sin(x) values to replay_probe.csv',
  capturedAt: '2026-09-14T10:00:00.000Z'
}

let container: HTMLDivElement
let root: Root

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<HumanEvidenceSection reviewId="review-1" />)
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      reviewer: { evidence: vi.fn(async () => ({ attachments: [attachment] })) },
      search: {
        evidence: vi.fn(async () => ({ status: 'verified', fingerprint: attachment.fingerprint }))
      }
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('HumanEvidenceSection', () => {
  it('lists a pinned block with the query that found it and its fingerprint', async () => {
    await render()

    const section = document.querySelector('[data-testid="review-human-evidence"]')
    expect(section).toBeTruthy()
    expect(section?.textContent).toContain('Human-pinned evidence')
    expect(section?.textContent).toContain('wrote sin(x) values to replay_probe.csv')
    expect(section?.textContent).toContain('Found by: sin csv (sin, csv)')
    expect(section?.textContent).toContain(attachment.fingerprint)
    expect(window.api.reviewer.evidence).toHaveBeenCalledWith({
      action: 'list',
      reviewIds: ['review-1']
    })
  })

  it('rechecks the pinned block and says it still matches', async () => {
    await render()

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="review-human-evidence-verify"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(window.api.search.evidence).toHaveBeenCalledWith({
      action: 'verify',
      line: {
        schemaVersion: 1,
        projectId: 'project-a',
        sessionId: 'session-a',
        messageId: 'message-2',
        role: 'agent',
        capturedAt: '2026-09-14T10:00:00.000Z',
        query: 'sin csv',
        terms: ['sin', 'csv'],
        snippet: 'wrote sin(x) values to replay_probe.csv',
        fingerprint: attachment.fingerprint
      }
    })
    expect(
      document.querySelector('[data-testid="review-human-evidence-status"]')?.textContent
    ).toBe('Still matches')
  })

  it('reports a changed block instead of implying the pin still holds', async () => {
    vi.mocked(window.api.search.evidence).mockResolvedValue({
      status: 'unavailable',
      reason: 'fingerprint-mismatch',
      fingerprintNow: `sha256:${'b'.repeat(64)}`
    })
    await render()

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="review-human-evidence-verify"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(
      document.querySelector('[data-testid="review-human-evidence-status"]')?.textContent
    ).toBe('Block changed')
  })

  it('says nothing is pinned rather than leaving the section ambiguous', async () => {
    vi.mocked(window.api.reviewer.evidence).mockResolvedValue({ attachments: [] })
    await render()

    expect(document.querySelector('[data-testid="review-human-evidence"]')?.textContent).toContain(
      'No evidence pinned yet'
    )
  })

  it('says the list could not be read rather than showing it as empty', async () => {
    vi.mocked(window.api.reviewer.evidence).mockRejectedValue(new Error('db unavailable'))
    await render()

    expect(document.body.textContent).toContain('Evidence could not be read')
    expect(document.querySelector('[data-testid="review-human-evidence"]')).toBeNull()
  })
})
