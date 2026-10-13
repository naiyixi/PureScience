import { createHash } from 'node:crypto'

// Per-run risk review for notebook cells. Pure: it reads the source text and says what it found, with
// no filesystem, no process and no clock — so the verdict is reproducible from the same cell text, and
// the receipt below can be recomputed by anyone holding the published recipe.
//
// The rules are deliberately NARROW and named. A reviewer must be able to read *which* rule fired and
// *which line* it fired on; a bare "this looks risky" is the failure mode this module exists to avoid.
// Anything a rule cannot decide from the text alone (how large a file will actually become, whether a
// path exists) is NOT guessed at here: those belong to the admission path, which has the real environment.

export type RunRiskRuleId = 'fs-delete' | 'fs-overwrite' | 'shell-exec' | 'large-allocation'

export type RunRiskHit = {
  ruleId: RunRiskRuleId
  /** The rule's own version, so a receipt stays recomputable after the rule set grows. */
  ruleVersion: string
  /** 1-based line numbers of the matching lines, in source order. */
  lines: number[]
  /** The matched line texts (trimmed), in the same order as `lines`. */
  excerpts: string[]
}

export type NotebookRunRiskAssessment = {
  /** 'review' when at least one named rule fired; 'allow' when the cell asks for nothing on the list. */
  verdict: 'allow' | 'review'
  hits: RunRiskHit[]
  /** sha256 of the cell source, printed in the receipt next to the verdict. */
  codeHash: string
  /** The rule set's version — a receipt names it, so a recomputation knows which rules were in force. */
  ruleSetVersion: string
}

export const NOTEBOOK_RUN_RISK_RULE_SET_VERSION = 'notebook-run-risk:v1'

type RunRiskRule = {
  id: RunRiskRuleId
  version: string
  pattern: RegExp
}

// Each pattern is line-anchored on purpose: a hit reports the line a reader can look at.
const RUN_RISK_RULES: readonly RunRiskRule[] = [
  {
    id: 'fs-delete',
    version: 'v1',
    pattern:
      /(?:\b(?:os\.remove|os\.unlink|os\.rmdir|os\.removedirs|shutil\.rmtree|Path\([^)]*\)\s*\.\s*unlink|\.unlink\(|\.rmdir\(|fs\.unlinkSync|fs\.rmSync|unlink\()|!rm\s|!\S*\s+[^\n]*\brm\s+-[a-zA-Z]*[rf]|!find\s[^\n]*\s-delete\b|!shred\s)/
  },
  {
    id: 'fs-overwrite',
    version: 'v1',
    pattern:
      /(?:\bopen\([^\n)]*,\s*['"][wax]b?\+?['"]|\.write_text\(|\.write_bytes\(|\.to_csv\((?![^\n]*mode\s*=\s*['"]a)|\.to_excel\((?![^\n]*mode\s*=\s*['"]a)|\.savefig\(|\bnp\.save\(|\bpickle\.dump\(|!>\s|!>>\s|\bwriteFileSync\()/
  },
  {
    id: 'shell-exec',
    version: 'v1',
    pattern:
      /(?:\bsubprocess\.(?:run|call|check_call|check_output|Popen)\(|\bos\.system\(|\bos\.popen\(|!sudo\s|!curl\s[^\n]*\|\s*(?:sh|bash)\b|\bchild_process\.exec(?:Sync)?\()/
  },
  {
    id: 'large-allocation',
    version: 'v1',
    pattern: /\b(?:np\.(?:zeros|ones|empty|full)\(|torch\.(?:zeros|ones|empty)\()/
  }
]

// A cell that allocates more than this many elements in one call is called out: the number is a floor,
// not a prediction (the rule reports the line; it does not claim to know the final size). A shape the
// line does not spell out in integers — `np.zeros(shape)` — is NOT treated as large: an unreadable size
// is not evidence of a big one, and firing there would train the reader to ignore the rule.
const LARGE_ALLOCATION_ELEMENTS = 100_000_000

const shapeElements = (line: string): number | undefined => {
  // Reads the call's own first balanced parenthesis group. A single `\(([^)]*)\)` is not enough:
  // numpy shapes are written `np.zeros((20000, 20000))`, where the first `)` closes the tuple and the
  // outer one closes the call — a naive slice truncated it to `(20000` and the rule stayed silent on
  // the very allocation it exists to catch (caught by this module's own test).
  const open = line.indexOf('(')
  if (open === -1) return undefined
  let depth = 0
  let close = -1
  for (let index = open; index < line.length; index += 1) {
    if (line[index] === '(') depth += 1
    else if (line[index] === ')') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close === -1) return undefined
  const numbers = line.slice(open + 1, close).match(/\d+/g)
  if (!numbers || numbers.length === 0) return undefined
  return numbers.reduce((total, raw) => total * Number(raw), 1)
}

/**
 * Names what a cell asks for, rule by rule, with the lines to look at. `large-allocation` only fires
 * when the call's own shape tuple multiplies past the floor — the rule reads what the line says rather
 * than guessing what a variable holds.
 */
export const evaluateNotebookRunRisk = (source: string): NotebookRunRiskAssessment => {
  const lines = source.split('\n')
  const hits: RunRiskHit[] = []

  for (const rule of RUN_RISK_RULES) {
    const matchedLines: number[] = []
    const excerpts: string[] = []

    lines.forEach((line, index) => {
      const isMatch =
        rule.id === 'large-allocation'
          ? rule.pattern.test(line) && (shapeElements(line) ?? 0) >= LARGE_ALLOCATION_ELEMENTS
          : rule.pattern.test(line)
      if (!isMatch) return
      matchedLines.push(index + 1)
      excerpts.push(line.trim())
    })

    if (matchedLines.length > 0) {
      hits.push({ ruleId: rule.id, ruleVersion: rule.version, lines: matchedLines, excerpts })
    }
  }

  return {
    verdict: hits.length > 0 ? 'review' : 'allow',
    hits,
    codeHash: createHash('sha256').update(source, 'utf8').digest('hex'),
    ruleSetVersion: NOTEBOOK_RUN_RISK_RULE_SET_VERSION
  }
}

/** The recipe a third party recomputes a receipt with. Printed beside the verdict, not retyped. */
export const NOTEBOOK_RUN_RISK_RECIPE =
  'sha256(utf8 cell source) + rule set notebook-run-risk:v1 (rules: fs-delete, fs-overwrite, shell-exec, large-allocation)'
