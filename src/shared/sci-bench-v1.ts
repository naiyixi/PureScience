// SciBench-Local v1 (v2.17 S1): the same scientific acceptance idea as v0, but the unit of grading
// is an ATOMIC CHECK inside one of six capability dimensions, and the checks are data — not code —
// so a case can be re-graded by anyone without reading the grader.
//
// Two rules this file is built around:
//   1. Package-agnostic. No check may name a library. A case passes because the science came out
//      right (a figure shipped with its script, a number carries provenance, a citation resolves),
//      never because a particular function was called.
//   2. Pass@1 counts only when EVERY atomic check of the case passes; the atomic pass-rate is
//      reported separately, because "failed the case" and "got everything wrong" are different
//      facts and a benchmark that blends them hides the difference.
//
// Scope honesty: S1 grades recorded evidence (transcript, tool calls, artifacts, numbers,
// citations). It does not run the agent; S3 wires the same cases to live arms.

import { evaluateSciBenchTrace, type SciBenchTrace } from './sci-bench'

export const DIMENSIONS = [
  'tool_grounding',
  'data_integrity',
  'object_plumbing',
  'methodological_robustness',
  'quantitative_quality',
  'biological_plausibility'
] as const

export type Dimension = (typeof DIMENSIONS)[number]

export type BenchEvidence = SciBenchTrace & {
  /** Artifacts with the script that produced each one, when the session recorded it. */
  artifactProducers?: { artifact: string; producedBy: string }[]
  /** Quantities the report states, with whatever provenance the session attached. */
  numbers?: { label: string; value: number; provenance?: string }[]
  /** Citations the report relies on, with the result of resolving them. */
  citations?: { ref: string; resolved: boolean; supportsClaim: boolean }[]
  /**
   * Skill files the run actually opened. Skills are files to the agent, so this is the only direct
   * observation of "did it consult a skill" — and consulting one is exactly what a contract/gap notice
   * is supposed to cause.
   */
  skillsRead?: string[]
}

export type AtomicCheck =
  | {
      kind: 'calls-tool'
      id: string
      dimension: Dimension
      description: string
      tool: string
    }
  | {
      kind: 'call-order'
      id: string
      dimension: Dimension
      description: string
      before: string
      after: string
    }
  | {
      kind: 'transcript-matches'
      id: string
      dimension: Dimension
      description: string
      /** Regular-expression source; must not name a library. */
      pattern: string
      mustMatch: boolean
    }
  | {
      kind: 'early-turn-matches'
      id: string
      dimension: Dimension
      description: string
      pattern: string
      /** How many opening turns count as "early". */
      withinTurns: number
    }
  | {
      kind: 'artifact-with-script'
      id: string
      dimension: Dimension
      description: string
      /** Artifact path pattern (regex source). */
      artifact: string
      /** Producing script path pattern (regex source). */
      script: string
    }
  | {
      /**
       * Did the run open this skill's own files? Skills are files to an agent, so this is the one
       * endpoint that can see "did a capability get consulted" at all — a `calls-tool` check cannot,
       * because connector work happens through `repl_execute` rather than as a tool of its own name.
       */
      kind: 'reads-skill'
      id: string
      dimension: Dimension
      description: string
      /** Skill directory name, matched against the `skills/<name>/…` path the read carried. */
      skill: string
    }
  | {
      kind: 'numbers-provenanced'
      id: string
      dimension: Dimension
      description: string
    }
  | {
      kind: 'citations-resolved'
      id: string
      dimension: Dimension
      description: string
    }

export type CaseDifficulty = 'easy' | 'medium' | 'hard'

export type BenchCaseV1 = {
  id: string
  title: string
  /** The case's primary dimension; individual checks may belong to others. */
  dimension: Dimension
  /** Difficulty is a statement about how many independent capabilities the task needs. */
  difficulty: CaseDifficulty
  /** The real record this case was drawn from (path or document), never invented. */
  origin: string
  /** What the user asked. States the scientific goal only — no API or library names. */
  prompt: string
  checks: AtomicCheck[]
}

export type CheckFinding = {
  checkId: string
  dimension: Dimension
  passed: boolean
  detail: string
}

export type CaseResult = {
  caseId: string
  passed: boolean
  /** Fraction of this case's atomic checks that passed (0 when the case has none). */
  atomicPassRate: number
  findings: CheckFinding[]
}

const artifactPaths = (evidence: BenchEvidence): string[] => [
  ...(evidence.artifacts ?? []),
  ...(evidence.artifactProducers ?? []).map((pair) => pair.artifact)
]

const hasAnyArtifact = (evidence: BenchEvidence, pattern: RegExp): boolean =>
  artifactPaths(evidence).some((path) => pattern.test(path))

const toolNames = (evidence: BenchEvidence): string[] =>
  (evidence.toolCalls ?? []).map((call) => call.name)

const evaluateCheck = (check: AtomicCheck, evidence: BenchEvidence): CheckFinding => {
  const base = { checkId: check.id, dimension: check.dimension }
  const transcript = evidence.transcript ?? ''

  switch (check.kind) {
    case 'calls-tool': {
      const passed = toolNames(evidence).includes(check.tool)
      return {
        ...base,
        passed,
        detail: passed
          ? `called ${check.tool}`
          : `${check.tool} never called (calls: ${toolNames(evidence).join(', ') || 'none'})`
      }
    }
    case 'call-order': {
      const names = toolNames(evidence)
      const before = names.indexOf(check.before)
      const after = names.indexOf(check.after)
      const passed = before !== -1 && after !== -1 && before < after
      return {
        ...base,
        passed,
        detail: passed
          ? `${check.before} preceded ${check.after}`
          : `${check.before}@${before} / ${check.after}@${after} — order not evidenced`
      }
    }
    case 'transcript-matches': {
      const passed = new RegExp(check.pattern, 'i').test(transcript) === check.mustMatch
      return {
        ...base,
        passed,
        detail: passed
          ? check.mustMatch
            ? 'pattern present'
            : 'pattern absent as required'
          : check.mustMatch
            ? `pattern missing: ${check.pattern}`
            : `forbidden pattern present: ${check.pattern}`
      }
    }
    case 'early-turn-matches': {
      const early = (evidence.turns ?? []).slice(0, Math.max(1, check.withinTurns)).join('\n')
      const passed = new RegExp(check.pattern, 'i').test(early)
      return {
        ...base,
        passed,
        detail: passed
          ? `stated within the first ${check.withinTurns} turn(s)`
          : `not stated within the first ${check.withinTurns} turn(s)`
      }
    }
    case 'artifact-with-script': {
      const artifactRegex = new RegExp(check.artifact, 'i')
      const scriptRegex = new RegExp(check.script, 'i')
      const artifactPresent = hasAnyArtifact(evidence, artifactRegex)
      // Two acceptable proofs, named apart: a recorded producer pairing, or a script shipped in the
      // same batch. The case asks that the figure travel with its generating script, and saying which
      // proof was found keeps "paired" from being silently claimed when only "co-delivered" is true.
      const paired = (evidence.artifactProducers ?? []).some(
        (pair) => artifactRegex.test(pair.artifact) && scriptRegex.test(pair.producedBy)
      )
      const scriptPresent = artifactPaths(evidence).some((path) => scriptRegex.test(path))
      const passed = artifactPresent && (paired || scriptPresent)
      // A bare "artifact missing" hides the most useful fact: what WAS produced. Naming the observed
      // paths (bounded) turns the finding into something a person can act on instead of a dead end.
      const produced = artifactPaths(evidence)
      const observed = produced.length
        ? `observed ${produced.length}: ${produced.slice(0, 3).join(', ')}${produced.length > 3 ? ', …' : ''}`
        : 'observed: no artifacts'
      return {
        ...base,
        passed,
        detail: passed
          ? paired
            ? 'artifact shipped together with its producing script'
            : 'artifact and script shipped together (producer pairing not recorded)'
          : artifactPresent
            ? 'artifact present but no producing script recorded'
            : `artifact missing — ${observed}`
      }
    }
    case 'reads-skill': {
      const reads = evidence.skillsRead ?? []
      // The materialized directory is `os-<id>`; accept either spelling so a check does not depend on
      // which runtime's layout produced the read.
      const wanted = check.skill.replace(/^os-/u, '')
      const hit = reads.some((entry) => entry.replace(/^os-/u, '') === wanted)
      return {
        ...base,
        passed: hit,
        detail: hit
          ? `read ${wanted}`
          : reads.length > 0
            ? `read other skills only: ${reads.join(', ')}`
            : 'no skill file was opened'
      }
    }
    case 'numbers-provenanced': {
      const numbers = evidence.numbers ?? []
      const unbacked = numbers.filter((entry) => !entry.provenance?.trim())
      const passed = numbers.length > 0 && unbacked.length === 0
      return {
        ...base,
        passed,
        detail: !numbers.length
          ? 'no quantities recorded to check'
          : unbacked.length
            ? `without provenance: ${unbacked.map((entry) => entry.label).join(', ')}`
            : `all ${numbers.length} quantities carry provenance`
      }
    }
    case 'citations-resolved': {
      const citations = evidence.citations ?? []
      const bad = citations.filter((entry) => !entry.resolved || !entry.supportsClaim)
      const passed = citations.length > 0 && bad.length === 0
      return {
        ...base,
        passed,
        detail: !citations.length
          ? 'no citations recorded to check'
          : bad.length
            ? `unresolved or unsupporting: ${bad.map((entry) => entry.ref).join(', ')}`
            : `all ${citations.length} citations resolve and support their claim`
      }
    }
  }
}

/** Grades one case. Deterministic: the same evidence always yields the same result. */
export const evaluateBenchCase = (benchCase: BenchCaseV1, evidence: BenchEvidence): CaseResult => {
  const findings = benchCase.checks.map((check) => evaluateCheck(check, evidence))
  const passedCount = findings.filter((finding) => finding.passed).length
  return {
    caseId: benchCase.id,
    passed: findings.length > 0 && passedCount === findings.length,
    atomicPassRate: findings.length ? passedCount / findings.length : 0,
    findings
  }
}

/** Coverage per dimension, so a corpus gap is a number rather than an impression. */
export const coverageMatrix = (
  cases: readonly BenchCaseV1[]
): Record<Dimension, { cases: number; ids: string[] }> => {
  const matrix = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, { cases: 0, ids: [] as string[] }])
  ) as Record<Dimension, { cases: number; ids: string[] }>
  for (const item of cases) {
    matrix[item.dimension].cases += 1
    matrix[item.dimension].ids.push(item.id)
  }
  for (const dimension of DIMENSIONS) matrix[dimension].ids.sort()
  return matrix
}

/** Aggregate over many cases: Pass@1 plus the atomic pass-rate the plan requires alongside it. */
export const summariseBench = (
  results: readonly CaseResult[]
): { cases: number; passed: number; passAt1: number; atomicPassRate: number } => {
  const totalChecks = results.reduce((sum, result) => sum + result.findings.length, 0)
  const passedChecks = results.reduce(
    (sum, result) => sum + result.findings.filter((finding) => finding.passed).length,
    0
  )
  const passed = results.filter((result) => result.passed).length
  return {
    cases: results.length,
    passed,
    passAt1: results.length ? passed / results.length : 0,
    atomicPassRate: totalChecks ? passedChecks / totalChecks : 0
  }
}

/**
 * A case may also be graded by the v0 rule engine when its origin came from there; this keeps one
 * benchmark from silently disagreeing with the other during the transition.
 */
export const crossCheckWithV0 = (
  v0Case: Parameters<typeof evaluateSciBenchTrace>[0],
  trace: SciBenchTrace
): boolean => evaluateSciBenchTrace(v0Case, trace).passed
