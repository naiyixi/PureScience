// Skill description trigger-quality evaluator: pure rules, no external model. A description
// that cannot trigger on its own (vague subject, no action/scenario vocabulary, walls of
// words) will never be loaded at the right time — this scorer makes that measurable and
// actionable. Five checks: first-sentence self-containment, action/scenario vocabulary,
// concrete subject, no filler-only wording, sane length.

import type { SkillEvalCheck, SkillEvalResult } from '../../shared/skill-eval'

// Words that make a description actionable ("use when", "creates", "troubleshoots" …).
const ACTION_WORDS = [
  'use when', 'use to', 'create', 'create ', 'edit', 'troubleshoot', 'debug', 'fix',
  'build', 'generate', 'convert', 'search', 'summarize', 'analyze', 'extract', 'monitor',
  'track', 'manage', 'install', 'deploy', 'write', 'read', 'parse', 'transform', 'merge',
  'review', 'verify', 'test', 'run', 'plan', 'write ', 'fetch', 'download', 'upload',
  'schedule', 'annotate', 'parse ', 'host', 'scrape', 'translate', 'convert '
]

// Words that indicate a vague, non-triggering description.
const FILLER_WORDS = [
  'help', 'assist', 'nice', 'useful', 'some', 'stuff', 'things', 'various', 'related',
  'general', 'misc', 'todo', 'miscellaneous'
]

// Weak openers that push the real content past the first sentence.
const WEAK_OPENERS = ['a skill for', 'this skill', 'skill for', 'the skill', 'a tool for']

const MIN_DESCRIPTION_CHARS = 40
const MAX_DESCRIPTION_CHARS = 200

export const evaluateSkillDescription = (description: string): SkillEvalResult => {
  const text = description.trim()
  const lower = text.toLowerCase()
  const checks: SkillEvalCheck[] = []
  const suggestions: string[] = []

  // Check 1: non-empty + sane length.
  const lengthOk = text.length >= MIN_DESCRIPTION_CHARS && text.length <= MAX_DESCRIPTION_CHARS
  checks.push({
    id: 'length',
    passed: lengthOk,
    message: lengthOk
      ? `Description is ${text.length} chars (good: ${MIN_DESCRIPTION_CHARS}-${MAX_DESCRIPTION_CHARS}).`
      : text.length === 0
        ? 'Description is empty — a skill with no description will never trigger.'
        : text.length < MIN_DESCRIPTION_CHARS
          ? `Description is only ${text.length} chars — too terse to trigger reliably (aim for ${MIN_DESCRIPTION_CHARS}+).`
          : `Description is ${text.length} chars — too long; the first sentence should carry the trigger.`
  })
  if (!lengthOk) {
    suggestions.push(
      text.length === 0
        ? 'Write one sentence that states what the skill does and when to use it.'
        : text.length < MIN_DESCRIPTION_CHARS
          ? 'Expand to a full sentence: what it does + when to use it + one concrete example.'
          : 'Trim to ~200 chars; keep the trigger in the first sentence.'
    )
  }

  // Check 2: first-sentence self-containment (the trigger must survive without the name).
  const firstSentence = text.split(/[.!?。！？]\s/)[0] ?? text
  const weakOpener = WEAK_OPENERS.some((opener) => firstSentence.toLowerCase().startsWith(opener))
  const selfContained =
    firstSentence.length >= 20 && !weakOpener && /[a-z]{4,}/i.test(firstSentence)
  checks.push({
    id: 'self_contained',
    passed: selfContained,
    message: selfContained
      ? 'First sentence stands alone as a trigger.'
      : weakOpener
        ? `First sentence starts with "${WEAK_OPENERS.find((o) => firstSentence.toLowerCase().startsWith(o))}" — it only makes sense with the skill name; rewrite to state the action directly.`
        : 'First sentence is too short or vague to trigger on its own.'
  })
  if (!selfContained && weakOpener) {
    suggestions.push('Drop the "a skill for" opener — start with the action verb and the subject.')
  }

  // Check 3: action/scenario vocabulary.
  const actionHits = ACTION_WORDS.filter((word) => lower.includes(word))
  checks.push({
    id: 'action_vocabulary',
    passed: actionHits.length > 0,
    message:
      actionHits.length > 0
        ? `Contains action/scenario vocabulary (${actionHits.slice(0, 3).join(', ')}).`
        : 'No action or scenario vocabulary — describe what the skill DOES or when to USE it.'
  })
  if (actionHits.length === 0) {
    suggestions.push('Add a "use when …" clause or a verb (creates, troubleshoots, converts…) so the loader can match it.')
  }

  // Check 4: concrete subject (a domain/technology noun, not pure filler).
  const fillerHits = FILLER_WORDS.filter((word) => lower.includes(word))
  const concrete = text.length >= 40 && (fillerHits.length === 0 || text.length >= 60)
  checks.push({
    id: 'concrete_subject',
    passed: concrete,
    message: concrete
      ? 'Names a concrete subject or domain.'
      : `Description leans on vague wording (${fillerHits.slice(0, 2).join(', ')}) — name the actual tool/domain/data.`
  })
  if (!concrete) {
    suggestions.push('Replace vague words with the concrete subject: the tool, the data type, or the domain it operates on.')
  }

  // Check 5: keyword density — at least one substantive 6+ char word beyond the opener.
  const substantiveWords = text
    .split(/\s+/)
    .filter((word) => /^[a-z0-9_-]{6,}$/i.test(word) && !ACTION_WORDS.includes(word.toLowerCase()))
  const hasKeyword = substantiveWords.length >= 1
  checks.push({
    id: 'keyword_density',
    passed: hasKeyword,
    message: hasKeyword
      ? `Carries a substantive keyword (${substantiveWords.slice(0, 2).join(', ')}).`
      : 'No substantive keyword — a loader cannot distinguish this skill from any other.'
  })
  if (!hasKeyword) {
    suggestions.push('Name the specific thing this skill works with (e.g. "AlphaFold", "PDF", "GitHub PRs") so matching is unambiguous.')
  }

  const passedCount = checks.filter((check) => check.passed).length
  const score = Math.round((passedCount / checks.length) * 10)

  return { score, checks, suggestions }
}
