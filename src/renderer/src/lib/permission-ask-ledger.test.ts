import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpPermissionRequest } from '../../../shared/acp'
import {
  permissionAskKey,
  readPermissionAskSummary,
  recordPresentedPermissionRequest,
  resetPermissionAskLedger,
  subscribePermissionAskLedger
} from './permission-ask-ledger'

const request = (
  overrides: Partial<AcpPermissionRequest> & { requestId: string }
): AcpPermissionRequest => ({
  sessionId: 'session-1',
  toolCallId: `tool-${overrides.requestId}`,
  title: 'Bash',
  options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  ...overrides
})

beforeEach(() => {
  resetPermissionAskLedger()
})

describe('permissionAskKey', () => {
  it('prefers the broker MCP identity, then the provider tool name, then the kind', () => {
    expect(
      permissionAskKey(
        request({ requestId: 'a', mcpIdentity: 'Server/Tool', providerToolName: 'x' })
      )
    ).toBe('server/tool')
    expect(permissionAskKey(request({ requestId: 'b', providerToolName: ' Write ' }))).toBe('write')
    expect(permissionAskKey(request({ requestId: 'c', toolKind: 'edit' }))).toBe('edit')
  })

  it('reports no identity rather than guessing from a provider-written title', () => {
    // A title is the provider's own prose ("Run the tests"), not a stable tool identity: two cards
    // for the same tool can carry different titles, so treating it as an identity would manufacture
    // repeats that never happened.
    expect(permissionAskKey(request({ requestId: 'd', title: 'Run the tests' }))).toBeUndefined()
    expect(permissionAskKey(request({ requestId: 'e', providerToolName: '   ' }))).toBeUndefined()
  })
})

describe('recordPresentedPermissionRequest', () => {
  it('counts a card once, however many times the surface re-renders', () => {
    const card = request({ requestId: 'r1', providerToolName: 'Bash' })

    expect(recordPresentedPermissionRequest(card)).toBe(true)
    expect(recordPresentedPermissionRequest(card)).toBe(false)
    expect(recordPresentedPermissionRequest({ ...card })).toBe(false)

    expect(readPermissionAskSummary('session-1')).toMatchObject({
      sessionId: 'session-1',
      asked: 1,
      distinct: 1,
      repeated: 0
    })
  })

  it('counts the second card for the same tool as a repeat, and each further one too', () => {
    recordPresentedPermissionRequest(request({ requestId: 'r1', providerToolName: 'Bash' }))
    recordPresentedPermissionRequest(request({ requestId: 'r2', providerToolName: 'Bash' }))
    recordPresentedPermissionRequest(request({ requestId: 'r3', providerToolName: 'Read' }))
    recordPresentedPermissionRequest(request({ requestId: 'r4', providerToolName: 'Bash' }))

    expect(readPermissionAskSummary('session-1')).toMatchObject({
      asked: 4,
      distinct: 2,
      repeated: 2
    })
  })

  it('never counts a card it cannot identify as a repeat', () => {
    recordPresentedPermissionRequest(request({ requestId: 'r1', title: 'one' }))
    recordPresentedPermissionRequest(request({ requestId: 'r2', title: 'two' }))

    expect(readPermissionAskSummary('session-1')).toMatchObject({
      asked: 2,
      distinct: 0,
      repeated: 0
    })
  })

  it('keeps one ledger per session', () => {
    recordPresentedPermissionRequest(
      request({ requestId: 'r1', sessionId: 'session-1', providerToolName: 'Bash' })
    )
    recordPresentedPermissionRequest(
      request({ requestId: 'r1', sessionId: 'session-2', providerToolName: 'Bash' })
    )
    recordPresentedPermissionRequest(
      request({ requestId: 'r2', sessionId: 'session-2', providerToolName: 'Bash' })
    )

    expect(readPermissionAskSummary('session-1')).toMatchObject({ asked: 1, repeated: 0 })
    expect(readPermissionAskSummary('session-2')).toMatchObject({ asked: 2, repeated: 1 })
    expect(readPermissionAskSummary('session-3')).toBeUndefined()
  })

  it('ignores a request without a request id or session id instead of inventing a bucket', () => {
    expect(recordPresentedPermissionRequest(request({ requestId: '' }))).toBe(false)
    expect(recordPresentedPermissionRequest(request({ requestId: 'r1', sessionId: '' }))).toBe(
      false
    )
    expect(readPermissionAskSummary('')).toBeUndefined()
  })
})

describe('readPermissionAskSummary', () => {
  it('keeps the same object identity until the count changes', () => {
    recordPresentedPermissionRequest(request({ requestId: 'r1', providerToolName: 'Bash' }))
    const first = readPermissionAskSummary('session-1')

    // useSyncExternalStore re-reads on every render: a fresh object per read would loop forever.
    expect(readPermissionAskSummary('session-1')).toBe(first)
    expect(readPermissionAskSummary(undefined)).toBeUndefined()

    recordPresentedPermissionRequest(request({ requestId: 'r2', providerToolName: 'Read' }))
    expect(readPermissionAskSummary('session-1')).not.toBe(first)
  })

  it('returns a frozen summary so a consumer cannot rewrite the ledger from outside', () => {
    recordPresentedPermissionRequest(request({ requestId: 'r1', providerToolName: 'Bash' }))
    const summary = readPermissionAskSummary('session-1')

    expect(Object.isFrozen(summary)).toBe(true)
  })
})

describe('subscribePermissionAskLedger', () => {
  it('notifies once per new card and not for a duplicate', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePermissionAskLedger(listener)
    const card = request({ requestId: 'r1', providerToolName: 'Bash' })

    recordPresentedPermissionRequest(card)
    recordPresentedPermissionRequest(card)

    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    recordPresentedPermissionRequest(request({ requestId: 'r2', providerToolName: 'Bash' }))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('resetPermissionAskLedger', () => {
  it('forgets every session so a fresh window starts at zero', () => {
    recordPresentedPermissionRequest(request({ requestId: 'r1', providerToolName: 'Bash' }))
    resetPermissionAskLedger()

    expect(readPermissionAskSummary('session-1')).toBeUndefined()
  })

  it('drops the oldest session once the tracked window fills', () => {
    for (let index = 0; index < 65; index += 1) {
      recordPresentedPermissionRequest(
        request({ requestId: `r${index}`, sessionId: `session-${index}`, providerToolName: 'Bash' })
      )
    }

    expect(readPermissionAskSummary('session-0')).toBeUndefined()
    expect(readPermissionAskSummary('session-64')).toMatchObject({ asked: 1 })
  })
})
