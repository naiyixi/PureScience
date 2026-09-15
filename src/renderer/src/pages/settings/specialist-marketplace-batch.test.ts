import { describe, expect, it, vi } from 'vitest'

import { runMarketplaceBatch, type MarketplaceBatchItem } from './specialist-marketplace-batch'

type Prepared = { id: string; blocked?: string; update?: boolean; installFails?: boolean }

const item = (id: string, name = id): MarketplaceBatchItem => ({ specialistId: id, name })

const ports = (prepared: Record<string, Prepared>) => ({
  prepare: vi.fn(async (target: MarketplaceBatchItem) => {
    const value = prepared[target.specialistId]
    if (!value) throw new Error(`offline: ${target.specialistId}`)
    return value
  }),
  readiness: (value: Prepared) =>
    value.blocked === undefined ? { ready: true } : { ready: false, reason: value.blocked },
  isUpdate: (value: Prepared) => value.update === true,
  install: vi.fn(async (value: Prepared) => {
    if (value.installFails) throw new Error(`install failed: ${value.id}`)
  })
})

describe('marketplace batch install', () => {
  it('prepares every item before installing, and installs only the ready ones', async () => {
    const p = ports({
      a: { id: 'a' },
      b: { id: 'b', blocked: 'package-modified-since-import' },
      c: { id: 'c', update: true }
    })

    const summary = await runMarketplaceBatch([item('a'), item('b'), item('c')], p)

    expect(p.prepare).toHaveBeenCalledTimes(3)
    expect(p.install).toHaveBeenCalledTimes(2)
    expect(summary.installed).toBe(1)
    expect(summary.updated).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.outcomes).toEqual([
      { specialistId: 'a', name: 'a', status: 'installed' },
      { specialistId: 'b', name: 'b', status: 'skipped', reason: 'package-modified-since-import' },
      { specialistId: 'c', name: 'c', status: 'updated' }
    ])
  })

  // The anti-shell rule for this surface: a batch that partly failed must not look like a success.
  it('keeps going after a failure and names the item that failed', async () => {
    const p = ports({ a: { id: 'a' }, b: { id: 'b', installFails: true }, c: { id: 'c' } })

    const summary = await runMarketplaceBatch([item('a'), item('b'), item('c')], p)

    expect(summary.installed).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.outcomes.find((outcome) => outcome.status === 'failed')).toMatchObject({
      specialistId: 'b',
      reason: 'install failed: b'
    })
    // It did not stop early: the item after the failure was still installed.
    expect(p.install).toHaveBeenCalledTimes(3)
  })

  it('reports an item that cannot even be fetched as that item’s failure', async () => {
    const p = ports({ a: { id: 'a' } })

    const summary = await runMarketplaceBatch([item('a'), item('missing')], p)

    expect(summary.installed).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.outcomes[1]).toMatchObject({ specialistId: 'missing', status: 'failed' })
  })

  it('reports each outcome as it happens, so progress is visible while the batch runs', async () => {
    const p = ports({ a: { id: 'a' }, b: { id: 'b' } })
    const seen: string[] = []

    await runMarketplaceBatch([item('a'), item('b')], {
      ...p,
      onOutcome: (outcome) => seen.push(`${outcome.specialistId}:${outcome.status}`)
    })

    expect(seen).toEqual(['a:installed', 'b:installed'])
  })

  it('is a no-op for an empty selection', async () => {
    const p = ports({})

    const summary = await runMarketplaceBatch([], p)

    expect(summary.outcomes).toEqual([])
    expect(p.prepare).not.toHaveBeenCalled()
  })
})
