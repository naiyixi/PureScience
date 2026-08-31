import { describe, expect, it, vi } from 'vitest'

import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'

import { ElicitationBroker } from './elicitation-broker'

const formRequest = (overrides: Partial<CreateElicitationRequest> = {}): CreateElicitationRequest =>
  ({
    mode: 'form',
    message: 'How should I analyze this dataset?',
    requestedSchema: {
      type: 'object',
      title: 'Analysis options',
      properties: {
        method: {
          type: 'string',
          title: 'Method',
          enum: ['DE', 'GSEA', 'Both']
        },
        alpha: { type: 'number', title: 'Alpha' },
        include_plots: { type: 'boolean', title: 'Include plots' }
      },
      required: ['method']
    },
    sessionId: 'session-1',
    ...overrides
  }) as unknown as CreateElicitationRequest

const createBroker = (): { broker: ElicitationBroker; emitRequest: ReturnType<typeof vi.fn> } => {
  const emitRequest = vi.fn()
  const broker = new ElicitationBroker({ emitRequest, now: () => 1000 })
  return { broker, emitRequest }
}

describe('ElicitationBroker', () => {
  it('projects a form request to the renderer and blocks until answered', async () => {
    const { broker, emitRequest } = createBroker()
    const pending = broker.requestElicitation(formRequest(), 'session-1')

    expect(emitRequest).toHaveBeenCalledTimes(1)
    const view = emitRequest.mock.calls[0][0]
    expect(view.message).toBe('How should I analyze this dataset?')
    expect(view.sessionId).toBe('session-1')
    expect(view.fields).toEqual([
      {
        key: 'method',
        kind: 'string',
        label: 'Method',
        required: true,
        choices: ['DE', 'GSEA', 'Both']
      },
      { key: 'alpha', kind: 'number', label: 'Alpha', required: false },
      { key: 'include_plots', kind: 'boolean', label: 'Include plots', required: false }
    ])

    let settled = false
    void pending.then((response) => {
      settled = true
      expect(response).toEqual({
        action: 'accept',
        content: { method: 'DE', alpha: 0.05, include_plots: true }
      })
    })

    const accepted = broker.respondElicitation(view.id, 'accept', {
      method: 'DE',
      alpha: 0.05,
      include_plots: true
    })
    expect(accepted).toBe(true)
    await pending
    expect(settled).toBe(true)
    expect(broker.pendingCount).toBe(0)
  })

  it('returns decline and cancel actions', async () => {
    const { broker, emitRequest } = createBroker()

    const declined = broker.requestElicitation(formRequest(), 'session-1')
    const declineView = emitRequest.mock.calls[0][0]
    broker.respondElicitation(declineView.id, 'decline')
    await expect(declined).resolves.toEqual({ action: 'decline' })

    const cancelled = broker.requestElicitation(formRequest(), 'session-1')
    const cancelView = emitRequest.mock.calls[1][0]
    broker.respondElicitation(cancelView.id, 'cancel')
    await expect(cancelled).resolves.toEqual({ action: 'cancel' })
  })

  it('fails closed on unsupported modes and empty messages', async () => {
    const { broker } = createBroker()
    await expect(
      broker.requestElicitation(
        { mode: 'url', message: 'x' } as unknown as CreateElicitationRequest,
        's'
      )
    ).resolves.toEqual({ action: 'cancel' })
    await expect(broker.requestElicitation(formRequest({ message: '   ' }), 's')).resolves.toEqual({
      action: 'cancel'
    })
  })

  it('fails closed when the schema violates bounds', async () => {
    const { broker } = createBroker()
    const tooManyFields: Record<string, unknown> = {}
    for (let i = 0; i < 9; i += 1) tooManyFields[`f${i}`] = { type: 'string' }
    await expect(
      broker.requestElicitation(
        formRequest({ requestedSchema: { type: 'object', properties: tooManyFields } } as never),
        's'
      )
    ).resolves.toEqual({ action: 'cancel' })

    const tooManyChoices = formRequest() as unknown as {
      requestedSchema: { properties: Record<string, unknown> }
    }
    tooManyChoices.requestedSchema.properties = {
      pick: { type: 'string', enum: Array.from({ length: 13 }, (_, i) => `c${i}`) }
    }
    await expect(broker.requestElicitation(tooManyChoices as never, 's')).resolves.toEqual({
      action: 'cancel'
    })
  })

  it('settles a pending elicitation when the agent completes it', async () => {
    const { broker, emitRequest } = createBroker()
    const pending = broker.requestElicitation(formRequest(), 'session-1')
    const view = emitRequest.mock.calls[0][0]

    broker.observeElicitationComplete({ elicitationId: view.id })
    await expect(pending).resolves.toEqual({ action: 'cancel' })
    expect(broker.pendingCount).toBe(0)
  })

  it('ignores responses for unknown or already-settled elicitations', async () => {
    const { broker, emitRequest } = createBroker()
    expect(broker.respondElicitation('missing', 'accept', {})).toBe(false)

    const pending = broker.requestElicitation(formRequest(), 'session-1')
    const view = emitRequest.mock.calls[0][0]
    broker.respondElicitation(view.id, 'decline')
    // Second response must not double-settle.
    expect(broker.respondElicitation(view.id, 'accept', { method: 'DE' })).toBe(false)
    await expect(pending).resolves.toEqual({ action: 'decline' })
  })

  it('cancels all pending elicitations for a session on teardown', async () => {
    const { broker, emitRequest } = createBroker()
    const first = broker.requestElicitation(formRequest(), 'session-1')
    const second = broker.requestElicitation(formRequest({ sessionId: 'session-2' }), 'session-2')
    const views = emitRequest.mock.calls.map((call) => call[0])

    broker.cancelSessionElicitations('session-1')
    await expect(first).resolves.toEqual({ action: 'cancel' })
    expect(broker.pendingCount).toBe(1)
    // The other session's card stays pending.
    broker.respondElicitation(views[1].id, 'accept', { method: 'GSEA' })
    await expect(second).resolves.toEqual({ action: 'accept', content: { method: 'GSEA' } })
  })

  it('times out an unanswered elicitation when configured', async () => {
    vi.useFakeTimers()
    try {
      const emitRequest = vi.fn()
      const broker = new ElicitationBroker({
        emitRequest,
        now: () => 1000,
        requestTimeoutMs: 5_000
      })
      const pending = broker.requestElicitation(formRequest(), 'session-1')
      vi.advanceTimersByTime(5_001)
      await expect(pending).resolves.toEqual({ action: 'cancel' })
      expect(broker.pendingCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists pending views for the renderer', async () => {
    const { broker, emitRequest } = createBroker()
    void broker.requestElicitation(formRequest(), 'session-1')
    const view = emitRequest.mock.calls[0][0]
    expect(broker.listPending()).toEqual([view])
  })
})
