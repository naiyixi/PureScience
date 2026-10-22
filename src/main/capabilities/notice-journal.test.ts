import { beforeEach, describe, expect, it } from 'vitest'

import {
  readCapabilityNoticeTally,
  recordCapabilityNotice,
  resetCapabilityNoticeTallies
} from './notice-journal'

beforeEach(() => {
  resetCapabilityNoticeTallies()
})

describe('capability notice journal', () => {
  it('separates "never asked" from "asked and had nothing to say"', () => {
    expect(readCapabilityNoticeTally('ses_unknown')).toBeNull()

    recordCapabilityNotice('ses_a', { injected: false, lines: 0 })
    recordCapabilityNotice('ses_a', { injected: false, lines: 0 })

    expect(readCapabilityNoticeTally('ses_a')).toEqual({
      injectedTurns: 0,
      turns: 2,
      lastLines: 0
    })
  })

  it('counts injected turns and remembers the last block size', () => {
    recordCapabilityNotice('ses_b', { injected: true, lines: 12 })
    recordCapabilityNotice('ses_b', { injected: true, lines: 3 })

    expect(readCapabilityNoticeTally('ses_b')).toEqual({
      injectedTurns: 2,
      turns: 2,
      lastLines: 3
    })
  })

  it('keeps sessions apart', () => {
    recordCapabilityNotice('ses_c', { injected: true, lines: 5 })
    expect(readCapabilityNoticeTally('ses_d')).toBeNull()
  })
})
