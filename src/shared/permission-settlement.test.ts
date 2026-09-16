import { describe, expect, it } from 'vitest'

import type { AcpPermissionRequest } from './acp'
import {
  groupPermissionSettlementBatches,
  permissionSettlementKey,
  permissionSettlementOptions,
  permissionSettlementSiblings
} from './permission-settlement'

const request = (overrides: Partial<AcpPermissionRequest> = {}): AcpPermissionRequest => ({
  requestId: 'req-1',
  sessionId: 'session-1',
  toolCallId: 'call-1',
  title: 'Read a file',
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ],
  ...overrides
})

describe('permission settlement grouping', () => {
  it('groups two calls to the same MCP tool as one decision', () => {
    const first = request({
      requestId: 'a',
      title: 'Query BioMart',
      isMcp: true,
      mcpIdentity: 'biomart/query'
    })
    const second = request({
      requestId: 'b',
      title: 'Query BioMart (2)',
      isMcp: true,
      mcpIdentity: 'biomart/query'
    })

    expect(permissionSettlementKey(first)).toBe(permissionSettlementKey(second))
    expect(
      permissionSettlementSiblings(first, [first, second]).map((entry) => entry.requestId)
    ).toEqual(['b'])
  })

  it('does not group different MCP tools, or an MCP call with a non-MCP one', () => {
    const biomart = request({ requestId: 'a', isMcp: true, mcpIdentity: 'biomart/query' })
    const ensembl = request({ requestId: 'b', isMcp: true, mcpIdentity: 'ensembl/lookup' })
    const shell = request({ requestId: 'c', providerToolName: 'bash' })

    expect(groupPermissionSettlementBatches([biomart, ensembl, shell])).toHaveLength(3)
    expect(permissionSettlementSiblings(biomart, [biomart, ensembl, shell])).toEqual([])
  })

  it('groups the same command prefix, which is what a remembered scope authorizes', () => {
    const first = request({ requestId: 'a', commandPrefix: ['git', 'push'] })
    const second = request({ requestId: 'b', commandPrefix: ['git', 'push'] })
    const other = request({ requestId: 'c', commandPrefix: ['rm', '-rf'] })

    const batches = groupPermissionSettlementBatches([first, second, other])
    expect(batches.map((batch) => batch.requests.length)).toEqual([2, 1])
    expect(
      permissionSettlementSiblings(first, [first, second, other]).map((e) => e.requestId)
    ).toEqual(['b'])
  })

  // Two anonymous requests share nothing but their anonymity, which is not a reason to decide both at once.
  it('never groups requests that carry no identity at all', () => {
    const first = request({ requestId: 'a', title: 'Something', options: [] })
    const second = request({ requestId: 'b', title: 'Something', options: [] })

    expect(permissionSettlementKey(first)).not.toBe(permissionSettlementKey(second))
    expect(groupPermissionSettlementBatches([first, second])).toHaveLength(2)
  })

  // Settling an option a request never offered would decide something it was never asked about.
  it('keeps only the options every request in the batch offers', () => {
    const first = request({
      requestId: 'a',
      commandPrefix: ['git', 'push'],
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-session', name: 'Allow session', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
      ]
    })
    const second = request({
      requestId: 'b',
      commandPrefix: ['git', 'push'],
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
      ]
    })

    expect(permissionSettlementOptions([first, second])).toEqual(['allow-once', 'deny'])
    expect(permissionSettlementOptions([first])).toEqual(['allow-once', 'allow-session', 'deny'])
  })
})
