import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { sessionDeletionMessage, type SessionDeletionNotice } from './session-deletion-notice'

// Records which key was chosen and with which variables. Interpolation is the provider's business
// (covered by its own tests); what this helper owns is picking the sentence that matches the receipt.
const captureTranslate = (): {
  calls: Array<{ key: string; vars?: Record<string, string | number> }>
  t: (key: keyof typeof en, vars?: Record<string, string | number>) => string
} => {
  const calls: Array<{ key: string; vars?: Record<string, string | number> }> = []
  return {
    calls,
    t: (key, vars) => {
      calls.push({ key, vars })
      return key
    }
  }
}

const notice = (notebookData: SessionDeletionNotice['notebookData']): SessionDeletionNotice => ({
  title: 'Notebook review',
  notebookData
})

describe('session deletion notice copy', () => {
  it('states the freed size when the run data was really released', () => {
    const { calls, t } = captureTranslate()

    const message = sessionDeletionMessage(notice({ freedBytes: 2048, state: 'removed' }), 'en', t)

    expect(message).toBe('ws.sessionDeletedReleased')
    expect(calls).toEqual([
      { key: 'ws.sessionDeletedReleased', vars: { title: 'Notebook review', size: '2.0 KB' } }
    ])
  })

  it('claims nothing was stored only when the removal found nothing', () => {
    const { calls, t } = captureTranslate()

    expect(sessionDeletionMessage(notice({ freedBytes: 0, state: 'absent' }), 'en', t)).toBe(
      'ws.sessionDeletedNothingStored'
    )
    expect(calls[0]?.vars).toEqual({ title: 'Notebook review' })
  })

  it('says the run data was not released for a refusal, a failure, or no receipt at all', () => {
    const states = [
      { freedBytes: 0, state: 'refused' as const },
      { freedBytes: 0, state: 'failed' as const },
      undefined
    ]

    for (const state of states) {
      const { calls, t } = captureTranslate()
      expect(sessionDeletionMessage(notice(state), 'en', t)).toBe('ws.sessionDeletedRunDataKept')
      expect(calls[0]?.key).not.toBe('ws.sessionDeletedReleased')
    }
  })

  it('keeps both placeholders in the English copy, so a figure never disappears silently', () => {
    // If either placeholder were dropped from the dictionary the helper would still return a key, and
    // the notice would print a sentence with no size and no session name.
    expect(en['ws.sessionDeletedReleased']).toContain('{title}')
    expect(en['ws.sessionDeletedReleased']).toContain('{size}')
    expect(en['ws.sessionDeletedNothingStored']).toContain('{title}')
    expect(en['ws.sessionDeletedRunDataKept']).toContain('{title}')
  })
})
