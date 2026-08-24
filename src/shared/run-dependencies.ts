// Lightweight cross-run dependency tracking for notebook sessions. Each completed run records
// the variable names its script writes (assignments and deletions); a later run that writes the
// same name makes earlier outputs stale — the transcript can surface "this result reflects an
// earlier variable state" instead of silently showing outdated figures.
//
// This is a conservative, syntax-light extractor (not a full tree-sitter analysis): it catches
// the common assignment shapes and ignores imports/definitions/control flow, so false negatives
// are possible but false positives are rare. A name that was never actually read by a downstream
// cell may be flagged stale — acceptable for a transparency marker.

// Built with RegExp constructors so R's `<-` assignment stays readable inside the alternation.
const ASSIGNMENT_RE = new RegExp(
  '^([A-Za-z_][A-Za-z0-9_]*)(?:\\.[A-Za-z_][A-Za-z0-9_]*)*\\s*(?:=|<-|\\+=|-=|\\*=|/=|%=|\\|=|&=|\\^=)'
)

const DELETE_RE = /^(?:del|rm)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)/

const SKIP_PREFIX_RE =
  /^(?:import |from |def |class |for |if |while |return |with |elif |else |print|fig\.|plt\.|library\(|require\(|source\(|install\.packages|ggplot|p\.|r\.)/

// Extracts the base variable names a script writes. Returns a sorted, de-duplicated list.
export const extractVariablesWritten = (script: string): string[] => {
  const written = new Set<string>()
  for (const rawLine of script.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    if (SKIP_PREFIX_RE.test(line)) continue

    const assignment = line.match(ASSIGNMENT_RE)
    if (assignment) {
      written.add(assignment[1])
      continue
    }
    const deletion = line.match(DELETE_RE)
    if (deletion) {
      for (const name of deletion[1].split(',')) {
        const trimmed = name.trim()
        if (trimmed) written.add(trimmed)
      }
    }
  }
  return [...written].sort()
}

// Given the ordered run list, marks each completed run whose written variables were re-written
// by a later completed run. Returns a Set of run ids that are now stale.
export const computeStaleRunIds = (
  runs: readonly { runId: string; status: string; variablesWritten?: string[] }[]
): Set<string> => {
  const stale = new Set<string>()
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]
    if (!run.variablesWritten || run.variablesWritten.length === 0) continue
    const written = new Set(run.variablesWritten)
    for (let j = i + 1; j < runs.length; j += 1) {
      const later = runs[j]
      if (later.status !== 'completed') continue
      if ((later.variablesWritten ?? []).some((name) => written.has(name))) {
        stale.add(run.runId)
        break
      }
    }
  }
  return stale
}
