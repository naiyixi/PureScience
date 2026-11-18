import { describe, expect, it } from 'vitest'
import { SessionBindingService } from './session-binding'
import type { ProfileService } from './service'

const profileService = {} as unknown as ProfileService

describe('SessionBindingService.seed', () => {
  it('restores a binding recorded in the session file, which the in-memory map does not survive', () => {
    const service = new SessionBindingService(profileService)

    expect(service.getBinding('session-a')).toBeUndefined()
    expect(
      service.seed([
        { id: 'session-a', specialistId: 'tcm-evidence-expert' },
        { id: 'session-b' },
        { id: 'session-c', specialistId: '' }
      ])
    ).toBe(1)
    expect(service.getBinding('session-a')).toBe('tcm-evidence-expert')
    expect(service.getBinding('session-b')).toBeUndefined()
    expect(service.getBinding('session-c')).toBeUndefined()
  })

  it('never reverts a switch made after startup', () => {
    const service = new SessionBindingService(profileService)
    service.setBinding('session-a', 'radiology-imaging-expert')

    // A slower restore resolving after the user switched must keep the newer choice.
    expect(service.seed([{ id: 'session-a', specialistId: 'tcm-evidence-expert' }])).toBe(0)
    expect(service.getBinding('session-a')).toBe('radiology-imaging-expert')
  })

  it('is idempotent across repeated restores', () => {
    const service = new SessionBindingService(profileService)
    const sessions = [{ id: 'session-a', specialistId: 'tcm-evidence-expert' }]

    expect(service.seed(sessions)).toBe(1)
    expect(service.seed(sessions)).toBe(0)
  })

  it('leaves a cleared binding cleared, because the durable record no longer carries an id', () => {
    const service = new SessionBindingService(profileService)
    service.setBinding('session-a', 'tcm-evidence-expert')
    // Clearing writes no specialistId to the session file (persistSessionSpecialist runs first), so the
    // restore pass has nothing to put back.
    service.setBinding('session-a', undefined)
    expect(service.seed([{ id: 'session-a' }])).toBe(0)
    expect(service.getBinding('session-a')).toBeUndefined()
  })
})
