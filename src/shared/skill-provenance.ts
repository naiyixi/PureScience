// Skill/memory provenance + verification gate.
//
// Learnt from the "live self-improvement" line of work: a procedure distilled during a run must not
// become silently reusable before something has verified it. An agent-drafted entry therefore carries
// an explicit trust state, and ONLY `verified` entries are reusable without human review — a run that
// half-worked must not be able to teach the harness a habit.
//
// The state lives in SKILL.md frontmatter so it survives export/import, the materializer, and the
// catalog without a second database.

export const SKILL_TRUST_KEY = 'trust'
export const SKILL_TRUST_KIND_KEY = 'trust_kind'
export const SKILL_TRUST_EVIDENCE_KEY = 'trust_evidence'
export const SKILL_TRUST_SOURCE_KEY = 'trust_verified_by'
export const SKILL_TRUST_ORIGIN_KEY = 'trust_origin'

// What kind of knowledge the entry carries. `failure-mode` is negative knowledge ("this path does not
// work: pip cannot build vina; use the conda package") — worth keeping even from a failed run, because
// its value is the reproducible evidence, not the outcome.
export type SkillKnowledgeKind = 'procedure' | 'failure-mode'

export const SKILL_KNOWLEDGE_KINDS: readonly SkillKnowledgeKind[] = ['procedure', 'failure-mode']

// A failure-mode entry is only worth keeping for its evidence: the command that fails and the error it
// produces. An entry that says "this does not work" without a reproduction is a rumour, so the creator
// refuses to record one (see SkillCreator.create).
export const requiresEvidence = (kind: SkillKnowledgeKind): boolean => kind === 'failure-mode'

export type SkillVerification = 'unverified' | 'verified' | 'rejected'

// Who/what verified it. `sci-bench` = the mechanical acceptance rules, `checkpoint` = a passing input
// fingerprint check, `user` = the person said so, `reviewer` = the in-app auditor.
export type SkillVerificationSource = 'sci-bench' | 'checkpoint' | 'user' | 'reviewer'

export type SkillProvenance = {
  kind: SkillKnowledgeKind
  verification: SkillVerification
  verifiedBy?: SkillVerificationSource
  // Where the knowledge came from, when known (session run / turn ids).
  originRunId?: string
  originTurnId?: string
  // Reproducible handles: command + error, artifact path, commit, dataset fingerprint…
  evidence: string[]
}

export const DEFAULT_SKILL_PROVENANCE: SkillProvenance = {
  kind: 'procedure',
  verification: 'unverified',
  evidence: []
}

// The gate: only verified knowledge may be reused without review. Everything else stays discoverable
// (skill_list / Settings) but must not be auto-loaded or treated as an established procedure.
export const isReusableWithoutReview = (provenance: SkillProvenance): boolean =>
  provenance.verification === 'verified'

// May this entry reach a session without the user asking for it? Curated skills have no provenance at
// all (they are not learnt from a run), verified knowledge is reusable, and a learnt-but-unverified
// entry needs its id on the explicit allow-list: a half-finished run must not become an established
// habit just because nobody turned it off.
export const isProvisionableSkill = (
  provenance: SkillProvenance | undefined,
  id: string,
  allowedIds: readonly string[] = []
): boolean =>
  provenance === undefined || isReusableWithoutReview(provenance) || allowedIds.includes(id)

// One sentence for the Settings badge and for the agent when it reads the entry.
export const describeSkillTrust = (provenance: SkillProvenance): string => {
  const source = provenance.verifiedBy ? ` (${provenance.verifiedBy})` : ''
  switch (provenance.verification) {
    case 'verified':
      return `Verified${source} — safe to reuse.`
    case 'rejected':
      return 'Rejected — this approach failed and must not be reused.'
    default:
      return provenance.kind === 'failure-mode'
        ? 'Unverified failure note — read the evidence before acting on it.'
        : 'Unverified — recorded during a run that has not been checked yet; do not reuse without review.'
  }
}

const asVerification = (value: string | undefined): SkillVerification => {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'verified' || normalized === 'rejected' ? normalized : 'unverified'
}

const asKind = (value: string | undefined): SkillKnowledgeKind =>
  value?.trim().toLowerCase() === 'failure-mode' ? 'failure-mode' : 'procedure'

const asSource = (value: string | undefined): SkillVerificationSource | undefined => {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'sci-bench' ||
    normalized === 'checkpoint' ||
    normalized === 'user' ||
    normalized === 'reviewer'
    ? normalized
    : undefined
}

const asEvidence = (value: string | undefined): string[] =>
  (value ?? '')
    .split('\n')
    .flatMap((line) => line.split(';'))
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

// Frontmatter values are flat strings (see skill-frontmatter), so provenance round-trips as scalars:
// `trust_origin: <runId>/<turnId>` and newline- or semicolon-separated evidence.
export const parseSkillProvenance = (
  fields: Readonly<Record<string, string | undefined>>
): SkillProvenance => {
  const [runId, turnId] = (fields[SKILL_TRUST_ORIGIN_KEY] ?? '')
    .split('/')
    .map((part) => part.trim())
  const verifiedBy = asSource(fields[SKILL_TRUST_SOURCE_KEY])
  const evidence = asEvidence(fields[SKILL_TRUST_EVIDENCE_KEY])

  return {
    kind: asKind(fields[SKILL_TRUST_KIND_KEY]),
    verification: asVerification(fields[SKILL_TRUST_KEY]),
    ...(verifiedBy ? { verifiedBy } : {}),
    ...(runId ? { originRunId: runId } : {}),
    ...(turnId ? { originTurnId: turnId } : {}),
    evidence
  }
}

// Only the non-default fields are written, so an ordinary skill stays a two-line frontmatter.
export const skillProvenanceFields = (provenance: SkillProvenance): Record<string, string> => {
  const fields: Record<string, string> = {
    [SKILL_TRUST_KEY]: provenance.verification,
    [SKILL_TRUST_KIND_KEY]: provenance.kind
  }
  if (provenance.verifiedBy) fields[SKILL_TRUST_SOURCE_KEY] = provenance.verifiedBy
  const origin = [provenance.originRunId, provenance.originTurnId].filter(Boolean).join('/')
  if (origin) fields[SKILL_TRUST_ORIGIN_KEY] = origin
  if (provenance.evidence.length > 0) {
    fields[SKILL_TRUST_EVIDENCE_KEY] = provenance.evidence
      .map((item) => item.replace(/\n/g, ' '))
      .join('; ')
  }
  return fields
}
