import { describe, expect, it } from 'vitest'

import {
  ABLATION_ENV,
  DEFAULT_ABLATION_ARM,
  parseAblationArm,
  shouldStripContracts
} from './ablation'

describe('parseAblationArm', () => {
  it('defaults to the full arm when unset or empty', () => {
    expect(parseAblationArm(undefined)).toBe(DEFAULT_ABLATION_ARM)
    expect(parseAblationArm(null)).toBe(DEFAULT_ABLATION_ARM)
    expect(parseAblationArm('')).toBe(DEFAULT_ABLATION_ARM)
    expect(DEFAULT_ABLATION_ARM).toBe('full-contract')
  })

  it('accepts the supported arms', () => {
    expect(parseAblationArm('full-contract')).toBe('full-contract')
    expect(parseAblationArm('no-contract')).toBe('no-contract')
  })

  it('throws on an unknown arm, naming the value and the variable', () => {
    expect(() => parseAblationArm('no-contract ')).toThrow(ABLATION_ENV)
    expect(() => parseAblationArm('doc-only')).toThrow(/doc-only/)
    expect(() => parseAblationArm('doc-only')).toThrow(/full-contract, no-contract/)
  })
})

describe('shouldStripContracts', () => {
  it('strips only for the no-contract arm', () => {
    expect(shouldStripContracts('no-contract')).toBe(true)
    expect(shouldStripContracts('full-contract')).toBe(false)
  })
})
