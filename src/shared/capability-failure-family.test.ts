import { describe, expect, it } from 'vitest'

import { CAPABILITY_FAILURE_CLASSES } from './capability-contract'
import {
  CAPABILITY_FAILURE_FAMILY,
  REVIEW_FAILURE_FAMILIES,
  failureFamilyFor
} from './capability-failure-family'

describe('capability failure → review failure family', () => {
  it('maps every capability failure class, so nothing falls through to unknown', () => {
    for (const failureClass of CAPABILITY_FAILURE_CLASSES) {
      const family = failureFamilyFor(failureClass)
      expect(REVIEW_FAILURE_FAMILIES).toContain(family)
      // `unknown` is the panel's admission that it could not classify; a class we define ourselves is
      // never that.
      expect(family).not.toBe('unknown')
    }
  })

  it('keeps the distinctions that matter: bad call is protocol, missing object is storage', () => {
    expect(failureFamilyFor('invalid_arguments')).toBe('protocol')
    expect(failureFamilyFor('incompatible_object')).toBe('storage')
    expect(failureFamilyFor('unavailable_dependency')).toBe('provider')
  })

  it('places "the run could not start" and "the run failed" with the run, not with I/O', () => {
    expect(failureFamilyFor('missing_state')).toBe('runtime')
    expect(failureFamilyFor('failed_execution')).toBe('runtime')
  })

  it('publishes exactly the five capability classes', () => {
    expect(Object.keys(CAPABILITY_FAILURE_FAMILY).sort()).toEqual(
      [...CAPABILITY_FAILURE_CLASSES].sort()
    )
  })
})
