// Licensed-skill intent guard: detects skills whose license restricts non-commercial use so the
// app can ask for confirmation before enabling them under a commercial use intent.

// License identifiers / fragments that restrict commercial use. Matched case-insensitively against
// the SKILL.md `license` frontmatter field.
const NON_COMMERCIAL_PATTERNS = [
  /non-?commercial/i,
  /\bnc\b/i,
  /CC[ -]BY[ -]NC/i,
  /attribution[ -]noncommercial/i,
  /community[ -]license/i
]

export const isRestrictedLicense = (license: string | undefined): boolean => {
  if (!license) return false
  return NON_COMMERCIAL_PATTERNS.some((pattern) => pattern.test(license))
}
