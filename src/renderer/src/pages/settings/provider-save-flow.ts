import type { ValidateProviderResult } from '../../../../shared/settings'

// The provider save gate, as a decision rather than as page code.
//
// It used to be inline in SettingsPage.handleSave, where the only way to reach it was to drive a
// controlled form inside jsdom — which is why the rule had no test at all. The decision is the part
// worth pinning: a provider being ADDED is not saved until its connection test passes, while an edit
// keeps going (a rename is not a connection change, and the card already carries the test result).

export type ProviderSaveGateInput = {
  /** True when no provider existed before this save. */
  isNewProvider: boolean
  /** Writes the provider and answers its id, or undefined when there is nothing to validate. */
  persist: () => Promise<string | undefined>
  /** Tests the stored provider's connection. */
  validate: (providerId: string) => Promise<ValidateProviderResult>
  /** Called around the test so the UI can show which provider is being checked. */
  onBusy: (providerId: string | undefined) => void
  /** Turns a failed result into the sentence shown to the user. */
  describeFailure: (result: ValidateProviderResult) => string
}

export type ProviderSaveGateOutcome =
  /** The save is finished; the caller may leave the form. */
  | { status: 'complete'; providerId?: string; validation?: ValidateProviderResult }
  /** The provider is written but not usable; the caller has to stay and show `message`. */
  | { status: 'incomplete'; providerId: string; message: string }

export const runProviderSaveGate = async (
  input: ProviderSaveGateInput
): Promise<ProviderSaveGateOutcome> => {
  const providerId = await input.persist()
  if (!providerId) return { status: 'complete' }

  input.onBusy(providerId)
  let validation: ValidateProviderResult
  try {
    validation = await input.validate(providerId)
  } finally {
    input.onBusy(undefined)
  }

  if (input.isNewProvider && !validation.ok) {
    return {
      status: 'incomplete',
      providerId,
      message: input.describeFailure(validation)
    }
  }

  return { status: 'complete', providerId, validation }
}
