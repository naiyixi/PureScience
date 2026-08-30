import { describe, expect, it } from 'vitest'

import { isRestrictedLicense } from './skill-license'

describe('isRestrictedLicense', () => {
  it('flags non-commercial license fragments', () => {
    expect(isRestrictedLicense('CC-BY-NC-4.0')).toBe(true)
    expect(isRestrictedLicense('Attribution-NonCommercial 4.0')).toBe(true)
    expect(isRestrictedLicense('CC BY-NC-SA')).toBe(true)
    expect(isRestrictedLicense('non-commercial research only')).toBe(true)
    expect(isRestrictedLicense('MIT (NC) variant')).toBe(true)
  })

  it('accepts permissive and commercial licenses', () => {
    expect(isRestrictedLicense('MIT')).toBe(false)
    expect(isRestrictedLicense('Apache-2.0')).toBe(false)
    expect(isRestrictedLicense('BSD-3-Clause')).toBe(false)
    expect(isRestrictedLicense('CC-BY-4.0')).toBe(false)
    expect(isRestrictedLicense(undefined)).toBe(false)
    expect(isRestrictedLicense('')).toBe(false)
  })
})
