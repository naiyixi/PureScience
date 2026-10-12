/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Dev audit: surface user-visible English literals that bypass t().
// Pure-Node scan; heuristic patterns; no CI gate (drives the keying backlog).
// Usage: node scripts/i18n-hardcoded-audit.mjs            → scan the default roots
//        node scripts/i18n-hardcoded-audit.mjs <path…>    → scan those files/directories only
//
// The path form exists so this instrument can be replayed against a KNOWN-BAD revision (a file kept
// outside the tree, or an old checkout) — an audit tool whose miss cannot be demonstrated has no
// evidence that it would have caught anything.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['src/renderer/src', 'src/main']
const EXT = new Set(['.tsx', '.ts'])
// A walk bug (bad root, extension filter typo) used to look exactly like "no hardcoded copy left" —
// this floor makes an empty scan fail loudly instead.
const MIN_FILES_SCANNED = 500

// Text characters a sentence of interface copy can hold… and nothing a statement of code holds
// (`=`, `;`, `{}`, `$`, backticks are all excluded, so `const x = 1` can never read as prose).
const PROSE_CHARS = "[A-Za-z0-9 ,.&/():'’…_%+–-]"
const SENTENCE_END = '[.!?…]'

const patterns = [
  {
    name: 'attr literal',
    re: /(?:aria-label|title|placeholder|alt)="([A-Za-z][A-Za-z0-9 ,.&/():'’_%+–-]{5,})"/g
  },
  // Single-quoted attribute literals: prettier keeps both quote styles in this tree, and the
  // double-quote-only pattern above reports clean while these sit in the UI.
  {
    name: 'attr literal (single-quoted)',
    re: /(?:aria-label|title|placeholder|alt)='([A-Za-z][A-Za-z0-9 ,.&/():'’_%+–-]{5,})'/g
  },
  { name: 'jsx-text', re: />([A-Za-z][A-Za-z0-9 ,.&/():'’_%+–-]{8,})</g },
  // Text adjacent to an interpolation: `>Speaks the {endpoint}<` / `>{n} more items<`. The
  // `>...<` pattern above cannot match these because a brace sits between text and tag end.
  {
    name: 'jsx-text before interpolation',
    re: />([A-Za-z][A-Za-z0-9 ,.&/():'’_%+–-]{5,})\{[^}]*\}/g
  },
  {
    name: 'jsx-text after interpolation',
    re: />\{[^}]+\} ([A-Za-z][A-Za-z0-9 ,.&/():'’_%+–-]{5,})</g
  },
  { name: 'dquote', re: /"([A-Z][a-z]+ [A-Za-z0-9 ,.&/():'’_%+–-]{6,})"/g },
  // A JSX text line of its own: prettier wraps long copy onto its own line, so neither `>text<` nor
  // `>text{` appears anywhere on it — the `>` sits on the line above (`<AlertDialog.Description>`).
  // Requiring sentence-final punctuation is what keeps this from reading statements as copy.
  {
    name: 'jsx prose line',
    re: new RegExp(`^\\s*[.!?]?\\s*([A-Za-z]${PROSE_CHARS}{9,}${SENTENCE_END})\\s*$`, 'g'),
    minWords: 2
  },
  // Copy trailing an interpolation on its own line: `{t('…hint')} be undone.` — the fragment is the
  // defect, and it sits on a line that LOOKS like code because the interpolation is a t() call.
  {
    name: 'jsx prose after interpolation',
    re: new RegExp(
      `^\\s*(?:\\{[^}]*\\}\\s*)+([A-Za-z]${PROSE_CHARS}{5,}${SENTENCE_END})\\s*$`,
      'g'
    ),
    minWords: 2,
    allowLowercaseStart: true,
    runsWhenLineLooksLikeCode: true
  },
  // An English fragment at the head of a template literal, before its first interpolation:
  // `` ` and its ${n} …` `` is user-visible copy glued onto whatever came before it. The LEADING SPACE
  // is load-bearing: template literals that begin with a letter are overwhelmingly CSS utility lists and
  // test ids (`h-full rounded-full bg-primary …`, `shortcut-row-…`) — measured 520 hits tree-wide vs 2
  // once a leading space is required, and both survivors are real fragments (a message tail, a code line).
  {
    name: 'template literal prose fragment',
    re: /`( [A-Za-z][A-Za-z0-9 ,.&/'’…–-]{4,})\$\{/g,
    minWords: 2,
    allowLowercaseStart: true
  },
  // A screen-reader name assembled from a template literal: `aria-label={`Open ${skill.name}`}`. The
  // value is neither a string literal (the attr shapes above) nor `>text<` (the jsx shapes), so every
  // one of them was invisible. The body must START with a letter and hold only prose characters around
  // its interpolation — that is what keeps CSS utility templates (which begin with `${`) and test ids
  // (letters plus `-`, no interpolation in the value) out of the list.
  {
    name: 'attr template literal',
    re: /(?:aria-label|title|placeholder|alt)=\{`([A-Za-z][A-Za-z0-9 ,.&/():'’…_%+–-]*\$\{[^}]*\}[A-Za-z0-9 ,.&/():'’…_%+–-]*)`\}/g
  }
]

// A whole-line ONE-WORD label: prettier puts a short label on its own line, so the `>` lives on the
// line above and the `</` on the line below — neither `>text<` nor `>text{` appears anywhere on it.
// Measured tree-wide when this shape was added: 56 hits, and requiring BOTH neighbours (previous
// non-empty line ends with `>`, next starts with `</`) is what keeps free-standing identifiers out —
// without the neighbour rule the same file set yields hundreds of code lines. Requiring a capital
// first letter is not a whitelist: the lowercase variant measures 0 hits tree-wide (again with the
// neighbour rule), so allowing it would only add noise. Keep both rules when widening this.
const SHORT_LABEL_RE = /^\s*([A-Z][A-Za-z '’.-]{1,40})\s*$/

// Shapes whose hit is decided by a line's NEIGHBOURS rather than by the line itself. They are kept
// outside `patterns` (whose filters are line-local by construction) so that adding them cannot
// perturb the existing shapes' behaviour.
const neighbourShapes = [
  {
    name: 'jsx short label line',
    reportTexts: true,
    test: (lines, i) => {
      const m = SHORT_LABEL_RE.exec(lines[i])
      if (!m) return null
      const prev = nearestNonEmpty(lines, i, -1)
      const next = nearestNonEmpty(lines, i, +1)
      if (!prev.endsWith('>') || !next.startsWith('</')) return null
      return m[1]
    }
  }
]

// The nearest non-empty line in `step` direction — the label's bracket may be several blank lines
// away (comments, conditional wrappers), and stopping at blank lines would silently drop those hits.
function nearestNonEmpty(lines, i, step) {
  for (let j = i + step; j >= 0 && j < lines.length; j += step) {
    if (lines[j].trim() !== '') return lines[j].trim()
  }
  return ''
}

const skip = /(test|spec)\.(ts|tsx)$/
// The nine dictionaries ARE the translations: every value in them matches these patterns, so without
// this the backlog list leads with en.ts/fr.ts instead of the components that still bypass t().
const isDictionary = (file) => /\/i18n\/(en|zh|zh-Hant|ja|ko|de|fr|es|ru)\.ts$/.test(file)
const ignoreLine = (ln) =>
  /t\(|useLanguage|eslint-disable|aria-hidden|console\.|\.css|import |require\(|http|https|\/\/|language.*'|style=/.test(
    ln
  )

// Explicit paths (the replay form) may include single files, so a file is a target too.
const explicitTargets = process.argv.slice(2)
const roots = explicitTargets.length > 0 ? explicitTargets : ROOTS
const floor = explicitTargets.length > 0 ? 1 : MIN_FILES_SCANNED

const hits = []
const kindCounts = new Map()
let filesScanned = 0
for (const root of roots) {
  const visit = (target) => {
    const st = statSync(target)
    if (st.isDirectory()) {
      for (const e of readdirSync(target)) visit(join(target, e))
      return
    }
    if (!EXT.has(extname(target)) || skip.test(target) || isDictionary(target)) return
    filesScanned += 1
    const lines = readFileSync(target, 'utf8').split('\n')
    lines.forEach((ln, i) => {
      const ignored = ignoreLine(ln)
      for (const pat of patterns) {
        // `runsWhenLineLooksLikeCode` marks the shapes whose hit IS the residual text of a line that
        // looks like code (the surviving fragment of a t() interpolation); the line filter below is
        // about the line, but those shapes are about what the line leaves over.
        if (ignored && !pat.runsWhenLineLooksLikeCode) continue
        const re = new RegExp(pat.re.source, pat.re.flags)
        for (const m of ln.matchAll(re)) {
          // The stored text is trimmed for reading, but the filters below run on the raw capture so a
          // pre-existing shape cannot lose a hit to the trim (the original filter is preserved exactly).
          const raw = m[1]
          const text = raw.trim()
          if (raw.split(' ').length < (pat.minWords ?? 2) && raw.length < 7) continue
          if (/^[a-z]/.test(text) && !pat.allowLowercaseStart) continue
          hits.push({ file: target, line: i + 1, kind: pat.name, text: text.slice(0, 90) })
          kindCounts.set(pat.name, (kindCounts.get(pat.name) ?? 0) + 1)
        }
      }
      // Neighbour-dependent shapes: same line-level ignore rule, but the hit comes from the neighbours.
      if (!ignored) {
        for (const shape of neighbourShapes) {
          const text = shape.test(lines, i)
          if (text === null || text === undefined) continue
          hits.push({
            file: target,
            line: i + 1,
            kind: shape.name,
            text: String(text).slice(0, 90)
          })
          kindCounts.set(shape.name, (kindCounts.get(shape.name) ?? 0) + 1)
        }
      }
    })
  }
  visit(root)
}
const byFile = new Map()
for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1)
if (filesScanned < floor) {
  console.error(
    `scanned only ${filesScanned} file(s) (floor ${floor}) — the walk is broken, so a low hit count means nothing. Fix the scan before reading the number below.`
  )
  process.exit(2)
}
console.log(
  `scanned ${filesScanned} files; TOTAL heuristic hits: ${hits.length} across ${byFile.size} files`
)
for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${String(n).padStart(3)}  ${f}`)
}
console.log(
  '\n--- hits by shape (a flood in one shape means that shape needs tightening, not a backlog) ---'
)
for (const [name, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(3)}  ${name}`)
}
console.log('\n--- sample 40 (file:line kind | text) ---')
hits.slice(0, 40).forEach((h) => console.log(`${h.file}:${h.line} [${h.kind}] ${h.text}`))

// A shape marked `reportTexts` is a WORD backlog, not a line backlog: the same label appears in many
// files, and counting lines makes 56 findings look like 56 jobs. The distinct-text table is the view
// that says what actually has to be keyed.
for (const shape of [...patterns, ...neighbourShapes]) {
  if (!shape.reportTexts) continue
  const texts = new Map()
  for (const h of hits) if (h.kind === shape.name) texts.set(h.text, (texts.get(h.text) ?? 0) + 1)
  console.log(
    `\n--- distinct texts in "${shape.name}" (lines: ${kindCounts.get(shape.name) ?? 0}) ---`
  )
  for (const [text, n] of [...texts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )) {
    console.log(`${String(n).padStart(3)}  ${text}`)
  }
}
