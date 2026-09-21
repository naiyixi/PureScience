import { describe, expect, it, vi } from 'vitest'

import type { ValidateProviderResult } from '../../../../shared/settings'

import { runProviderSaveGate } from './provider-save-flow'

// The save gate's decision, pinned without a DOM. It lived inside SettingsPage.handleSave, where reaching
// it meant driving a controlled form in jsdom — which is why it had no test at all.

const failed = { ok: false, category: 'auth', message: 'Unauthorized' } as ValidateProviderResult
const passed = { ok: true } as ValidateProviderResult

describe('the provider save gate', () => {
  it('does not count a provider being added as saved until its connection test passes', async () => {
    const onBusy = vi.fn()
    const outcome = await runProviderSaveGate({
      isNewProvider: true,
      persist: async () => 'provider-new',
      validate: async () => failed,
      onBusy,
      describeFailure: () => 'Unauthorized'
    })

    expect(outcome).toEqual({
      status: 'incomplete',
      providerId: 'provider-new',
      message: 'Unauthorized'
    })
    // Busy is cleared again, or the provider's card would spin forever.
    expect(onBusy.mock.calls).toEqual([['provider-new'], [undefined]])
  })

  it('completes once the connection test passes', async () => {
    const outcome = await runProviderSaveGate({
      isNewProvider: true,
      persist: async () => 'provider-new',
      validate: async () => passed,
      onBusy: () => undefined,
      describeFailure: () => 'unused'
    })

    expect(outcome).toMatchObject({ status: 'complete', providerId: 'provider-new' })
  })

  it('lets an edit through even when the connection test fails', async () => {
    const outcome = await runProviderSaveGate({
      isNewProvider: false,
      persist: async () => 'provider-1',
      validate: async () => failed,
      onBusy: () => undefined,
      describeFailure: () => 'unused'
    })

    // A rename or a changed model list is not a connection change, and the card carries the result.
    expect(outcome).toMatchObject({ status: 'complete', providerId: 'provider-1' })
  })

  it('clears busy even when the test itself throws', async () => {
    const onBusy = vi.fn()

    await expect(
      runProviderSaveGate({
        isNewProvider: true,
        persist: async () => 'provider-new',
        validate: async () => {
          throw new Error('transport down')
        },
        onBusy,
        describeFailure: () => 'unused'
      })
    ).rejects.toThrow('transport down')

    expect(onBusy.mock.calls).toEqual([['provider-new'], [undefined]])
  })

  it('leaves validation alone when the save produced nothing to test', async () => {
    const validate = vi.fn()
    const outcome = await runProviderSaveGate({
      isNewProvider: true,
      persist: async () => undefined,
      validate,
      onBusy: () => undefined,
      describeFailure: () => 'unused'
    })

    expect(outcome).toEqual({ status: 'complete' })
    expect(validate).not.toHaveBeenCalled()
  })
})
