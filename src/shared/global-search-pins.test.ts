import { describe, expect, it } from 'vitest'

import {
  GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
  sanitizeGlobalSearchPin,
  sanitizeGlobalSearchPins
} from './global-search-pins'

// A set that cannot store its ordering cannot reproduce the page it described: the same filters read in a
// different order are a different page. These cases exist because a real save/apply round-trip dropped the
// ordering silently — the pin came back with the window it was saved with and the default order.

const storedPin = (filters: unknown): unknown => ({
  schemaVersion: GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
  id: 'pin-1',
  name: 'Bounded set',
  savedAt: '2026-09-30T10:00:00.000Z',
  filters
})

describe('pin filters keep the ordering', () => {
  it('keeps a known ordering, alongside the window it was saved with', () => {
    const pin = sanitizeGlobalSearchPin(
      storedPin({
        since: '2026-01-01T00:00:00.000Z',
        until: '2026-03-01T23:59:59.999Z',
        orderBy: 'time'
      })
    )

    expect(pin.filters).toEqual({
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-03-01T23:59:59.999Z',
      orderBy: 'time'
    })
  })

  it('never trusts an ordering it does not know', () => {
    const pin = sanitizeGlobalSearchPin(storedPin({ role: 'user', orderBy: 'newest' }))

    expect(pin.filters).toEqual({ role: 'user' })
  })

  it('still refuses a set with nothing usable in it', () => {
    expect(() => sanitizeGlobalSearchPin(storedPin({ orderBy: 'nonsense' }))).toThrow()
  })

  it('reports an unreadable store rather than inventing sets', () => {
    expect(
      sanitizeGlobalSearchPins([storedPin({ orderBy: 'time' })].concat([{ nope: true }]))
    ).toEqual([
      {
        schemaVersion: GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
        id: 'pin-1',
        name: 'Bounded set',
        savedAt: '2026-09-30T10:00:00.000Z',
        filters: { orderBy: 'time' }
      }
    ])
  })
})
