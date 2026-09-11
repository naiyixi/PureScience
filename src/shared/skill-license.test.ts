import { describe, expect, it } from 'vitest'

import {
  classifySkillLicense,
  isPermissiveLicense,
  isRestrictedLicense,
  requiresCommercialConfirmation
} from './skill-license'

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

describe('skill license classification', () => {
  it('treats known permissive licenses as allowed', () => {
    expect(classifySkillLicense({ license: 'MIT' })).toBe('allowed')
    expect(classifySkillLicense({ license: 'Apache-2.0' })).toBe('allowed')
    expect(classifySkillLicense({ license: 'BSD-3-Clause' })).toBe('allowed')
    expect(classifySkillLicense({ license: 'CC-BY-4.0' })).toBe('allowed')
  })

  it('flags non-commercial text as restricted', () => {
    expect(classifySkillLicense({ license: 'CC-BY-NC-4.0' })).toBe('restricted')
    expect(classifySkillLicense({ license: 'Community License' })).toBe('restricted')
  })

  it('fails closed on missing or unrecognised licenses', () => {
    expect(classifySkillLicense({})).toBe('needs-review')
    expect(classifySkillLicense({ license: 'Proprietary Academic Use Only v3' })).toBe('needs-review')
    expect(requiresCommercialConfirmation('needs-review')).toBe(true)
    expect(requiresCommercialConfirmation('restricted')).toBe(true)
    expect(requiresCommercialConfirmation('allowed')).toBe(false)
  })

  it('honours an explicit declaration but surfaces conflicts with the text', () => {
    expect(classifySkillLicense({ license: 'Custom-1.0', commercialUse: 'allowed' })).toBe('allowed')
    expect(classifySkillLicense({ license: 'Custom-1.0', commercialUse: 'restricted' })).toBe('restricted')
    expect(classifySkillLicense({ license: 'CC-BY-NC-4.0', commercialUse: 'allowed' })).toBe('needs-review')
  })

  it('recognises permissiveness conservatively', () => {
    expect(isPermissiveLicense('MIT')).toBe(true)
    expect(isPermissiveLicense('All rights reserved')).toBe(false)
    expect(isPermissiveLicense(undefined)).toBe(false)
  })
})
