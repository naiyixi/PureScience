// Skill self-bootstrapping contract: the skill_eval / skill_list / skill_read tools that
// complete the create → evaluate → iterate loop alongside create_skill. skill_eval is a pure
// description-trigger optimizer (no external model): it scores a skill description for how
// reliably it will trigger — first-sentence self-containment, action/scenario vocabulary, a
// concrete subject, and sane length — and returns concrete rewrites. skill_list/skill_read let
// the agent inspect the installed skill library so it can reuse, extend, or fix existing
// skills instead of duplicating them.

export const SKILL_EVAL_TOOL_NAME = 'skill_eval'
export const SKILL_LIST_TOOL_NAME = 'skill_list'
export const SKILL_READ_TOOL_NAME = 'skill_read'

export const SKILL_EVAL_TOOL_DESCRIPTION =
  'Evaluates a skill description for trigger quality and returns a score (0-10) plus ' +
  'actionable suggestions. A description triggers reliably when its first sentence is ' +
  'self-contained (states what the skill does and when, without needing the name), uses ' +
  'action/scenario vocabulary, and names a concrete subject. Run it on a draft before ' +
  'create_skill, and iterate until the score is ≥8.'

export const SKILL_LIST_TOOL_DESCRIPTION =
  'Lists the installed skills (name + description). Use it before creating a new skill to ' +
  'check whether one already covers the procedure — reuse and extend beats duplicating.'

export const SKILL_READ_TOOL_DESCRIPTION =
  "Reads one installed skill's full content (frontmatter + instructions). Use it to " +
  'understand an existing skill before extending it, or to verify what create_skill actually ' +
  'persisted.'

export type SkillEvalCheck = {
  id: string
  passed: boolean
  // Human-readable verdict for this check.
  message: string
}

export type SkillEvalResult = {
  // 0-10 trigger-quality score.
  score: number
  checks: SkillEvalCheck[]
  suggestions: string[]
}

export type SkillLibraryEntry = {
  name: string
  // First ~140 chars of the description (frontmatter), or empty when missing.
  description: string
}

export type SkillLibraryListResult = {
  skills: SkillLibraryEntry[]
}

export type SkillLibraryReadResult = {
  name: string
  description: string
  // Full markdown body (instructions) without the frontmatter.
  instructions: string
}

// Rendered into the session prompt when the skill MCP is available (extends the existing
// skill-create instructions).
export const SKILL_BOOTSTRAP_SYSTEM_PROMPT_APPEND = [
  '<purescience_skill_bootstrap_instructions>',
  'When drafting a skill, run skill_eval on its description first and iterate until the score ' +
    'is ≥8 — a description that cannot trigger on its own will never be loaded at the right time.',
  'Before creating a skill, run skill_list to check for overlap and skill_read on the closest ' +
    'match; extend an existing skill instead of duplicating it when the overlap is real.',
  '</purescience_skill_bootstrap_instructions>'
].join('\n')
