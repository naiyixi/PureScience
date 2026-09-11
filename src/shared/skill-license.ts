// Licensed-skill intent guard: classifies a skill's declared license so the app can decide whether
// enabling it under a commercial use intent needs an explicit confirmation.
//
// Fail-closed by design: an unrecognised or missing license is NOT treated as permissive — it is
// 'needs-review', so silent commercial use of an unclear license is never assumed. Authored
// declarations may tighten or (with a review marker) contradict the licence text, but a
// declaration that claims "allowed" while the text says non-commercial is surfaced as a conflict
// rather than silently trusted.

// License identifiers / fragments that restrict commercial use. Matched case-insensitively against
// the SKILL.md `license` frontmatter field.
const NON_COMMERCIAL_PATTERNS = [
  /non-?commercial/i,
  /\bnc\b/i,
  /CC[ -]BY[ -]NC/i,
  /attribution[ -]noncommercial/i,
  /community[ -]license/i
]

// Licenses we can treat as commercially usable without further review.
const PERMISSIVE_PATTERNS = [
  /^mit\b/i,
  /apache[ -]?2/i,
  /\bbsd(-[23]-clause)?\b/i,
  /\bisc\b/i,
  /mpl[ -]?2/i,
  /cc[ -]by[ -]4(\.0)?/i,
  /\bunlicense\b/i,
  /public[ -]domain|cc0/i
]

export type SkillLicenseStatus = 'allowed' | 'restricted' | 'needs-review'

export const isRestrictedLicense = (license: string | undefined): boolean => {
  if (!license) return false
  return NON_COMMERCIAL_PATTERNS.some((pattern) => pattern.test(license))
}

export const isPermissiveLicense = (license: string | undefined): boolean => {
  if (!license) return false
  return PERMISSIVE_PATTERNS.some((pattern) => pattern.test(license.trim()))
}

// `commercialUse` is the optional authored declaration from SKILL.md (commercial_use:
// allowed | restricted), which lets a custom licence be classified without a known identifier.
export const classifySkillLicense = (input: {
  license?: string
  commercialUse?: string
}): SkillLicenseStatus => {
  const declared = input.commercialUse?.trim().toLowerCase()
  const restrictedByText = isRestrictedLicense(input.license)
  const permissiveByText = isPermissiveLicense(input.license)

  if (declared === 'restricted') return 'restricted'
  if (declared === 'allowed') {
    // A declaration that contradicts the licence text is a conflict, not a permission.
    return restrictedByText ? 'needs-review' : 'allowed'
  }
  if (restrictedByText) return 'restricted'
  if (permissiveByText) return 'allowed'
  return 'needs-review'
}

// Anything that is not a clear 'allowed' asks the user before commercial use.
export const requiresCommercialConfirmation = (status: SkillLicenseStatus): boolean =>
  status !== 'allowed'
