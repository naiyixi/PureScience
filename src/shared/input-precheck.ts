// Input pre-check (D5).
//
// A task that names files which do not exist must say so in the FIRST reply. In the sessions that
// motivated this, the agent quietly substituted synthetic data, did the whole analysis, and only said
// "the inputs were missing, every number is synthetic" in the final report — the user read a result
// about data that was never there. The rule is therefore about WHEN the gap is declared, not whether.
//
// Two halves: an instruction every session gets, and a pure checker the app can run on the user's task
// text (see assessInputPaths) so the first reply can name the actual missing paths rather than guess.

export const INPUT_PRECHECK_SYSTEM_PROMPT_APPEND = [
  '<input_precheck>',
  'Before you plan a task, check that the inputs it names actually exist — a file, a directory, or a',
  'table the user pointed at. If something is missing, say so in your FIRST reply: name what is missing',
  'and offer the two honest options (the user supplies the path, or you continue on synthetic data that',
  'your outputs then label as synthetic).',
  'Never let a missing input appear for the first time in the final report: by then the work has already',
  'been done on data the user did not have.',
  '</input_precheck>'
].join('\n')

// Path-like tokens worth checking. A URL is not a local input, so URLs are removed before extraction;
// bare versions and statistics (v1.2.3, p<0.05) carry no slash and no data extension, so they never
// match. The body excludes CJK punctuation, which would otherwise be swallowed as part of a path, and
// the boundaries are "not a path character" so a path preceded by a Chinese comma or a quote is found.
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`()[\]【】，。；]+/gi

// What may appear inside a path: no whitespace, no quotes/brackets, and no CJK sentence punctuation.
const PATH_BODY = '[^\\s"\'`()\\[\\]{}<>，。；：、！？【】（）《》]+'

const PATH_LIKE = new RegExp(
  [
    '(?:^|[^\\w./~-])(',
    '(?:\\.{1,2}\\/|~\\/|\\/)' + PATH_BODY,
    '|[\\w.-]+\\/' + PATH_BODY,
    '|[\\w-]+\\.(?:csv|tsv|txt|xlsx?|json|parquet|fasta|fa|vcf|bam|h5|hdf5|npy|npz|pdb|cif|sdf|mol2|zip)',
    ')(?=$|[^\\w./-])'
  ].join(''),
  'gi'
)

// Trailing punctuation that belongs to the sentence, not to the path.
const TRAILING = /[.,;:!?，。；：！？、]+$/

/** The distinct path-like tokens a task text names, in order of first appearance. */
export const extractInputPathCandidates = (text: string): string[] => {
  const found: string[] = []
  for (const match of text.replace(URL, ' ').matchAll(PATH_LIKE)) {
    const raw = (match[1] ?? '').replace(TRAILING, '').trim()
    if (raw.length === 0) continue
    if (found.includes(raw)) continue
    found.push(raw)
  }
  return found
}

export type InputPrecheckResult = {
  /** Named paths that exist. */
  present: string[]
  /** Named paths that do not — the ones the first reply has to name. */
  missing: string[]
}

/**
 * Checks the paths a task names. `exists` is injected so the check stays pure and testable, and so the
 * caller decides what "exists" means for its host (the main process checks the session's cwd).
 */
export const assessInputPaths = (
  text: string,
  exists: (path: string) => boolean
): InputPrecheckResult => {
  const present: string[] = []
  const missing: string[] = []
  for (const candidate of extractInputPathCandidates(text)) {
    if (exists(candidate)) present.push(candidate)
    else missing.push(candidate)
  }
  return { present, missing }
}

/**
 * The notice to put in front of the agent (or the user) when inputs are missing. Empty when nothing is
 * missing, so a session whose inputs are all present reads exactly as before.
 */
export const buildMissingInputNotice = (result: InputPrecheckResult): string => {
  if (result.missing.length === 0) return ''
  return [
    '<missing_inputs>',
    `These inputs the task names do not exist: ${result.missing.join(', ')}.`,
    'Say so in your first reply — name them and ask for the paths, or state plainly that you will proceed',
    'on synthetic data and label every output that uses it as synthetic. Do not start the analysis and',
    'mention it later.',
    '</missing_inputs>'
  ].join('\n')
}
