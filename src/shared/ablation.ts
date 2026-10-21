// The ablation arm, as one environment variable. This exists so the benchmark can compare "contract
// declarations visible" against "not visible" on one machine, and it is deliberately NOT a product
// setting: nothing in the UI writes it, nothing persists it, and the default (unset) is exactly the
// behaviour every user already gets.
//
// Why an env var rather than a per-run field: skill materialization is application-level (the
// provisioned config dir), not per-run — a per-run knob today would be accepted and then ignored,
// which is the worst possible outcome for an experiment. See
// docs/plan-2026-10-21-s3-four-arm-run.md §2.1.
//
// An unknown value throws. A typo that silently fell back to the default would label a run with an
// arm it did not run under.

export const ABLATION_ENV = 'PURESCIENCE_ABLATION'

export const ABLATION_ARMS = ['full-contract', 'no-contract'] as const

export type AblationArm = (typeof ABLATION_ARMS)[number]

export const DEFAULT_ABLATION_ARM: AblationArm = 'full-contract'

/**
 * @throws when the value is set but is not a supported arm — the message names the value, so a
 *   mislabelled experiment is caught at provisioning time rather than in the results.
 */
export const parseAblationArm = (value: string | undefined | null): AblationArm => {
  if (value === undefined || value === null || value === '') return DEFAULT_ABLATION_ARM
  if ((ABLATION_ARMS as readonly string[]).includes(value)) return value as AblationArm
  throw new Error(
    `Unknown ${ABLATION_ENV} value "${value}". Supported: ${ABLATION_ARMS.join(', ')}. ` +
      'Unset it to get the default arm.'
  )
}

/** True when the materializer should drop contract declarations for this arm. */
export const shouldStripContracts = (arm: AblationArm): boolean => arm === 'no-contract'
