/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Dev audit: surface user-visible English literals that bypass t().
// Pure-Node scan; heuristic patterns; no CI gate (drives the keying backlog).
// Usage: node scripts/i18n-hardcoded-audit.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['src/renderer/src', 'src/main']
const EXT = new Set(['.tsx', '.ts'])
// A walk bug (bad root, extension filter typo) used to look exactly like "no hardcoded copy left" —
// this floor makes an empty scan fail loudly instead.
const MIN_FILES_SCANNED = 500

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
    re: />([A-Za-z][A-Za-z0-9 ,.&/():'’_%+–-]{5,})\{[^}]*\}</g
  },
  {
    name: 'jsx-text after interpolation',
    re: />\{[^}]+\} ([A-Za-z][A-Za-z0-9 ,.&/():'’_%+–-]{5,})</g
  },
  { name: 'dquote', re: /"([A-Z][a-z]+ [A-Za-z0-9 ,.&/():'’_%+–-]{6,})"/g }
]

const skip = /(test|spec)\.(ts|tsx)$/
// The nine dictionaries ARE the translations: every value in them matches these patterns, so without
// this the backlog list leads with en.ts/fr.ts instead of the components that still bypass t().
const isDictionary = (file) => /\/i18n\/(en|zh|zh-Hant|ja|ko|de|fr|es|ru)\.ts$/.test(file)
const ignoreLine = (ln) =>
  /t\(|useLanguage|eslint-disable|aria-hidden|console\.|\.css|import |require\(|http|https|\/\/|language.*'|style=/.test(
    ln
  )

const hits = []
let filesScanned = 0
for (const root of ROOTS) {
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (EXT.has(extname(p)) && !skip.test(e) && !isDictionary(p)) {
        filesScanned += 1
        const lines = readFileSync(p, 'utf8').split('\n')
        lines.forEach((ln, i) => {
          if (ignoreLine(ln)) return
          for (const pat of patterns) {
            for (const m of ln.matchAll(pat.re)) {
              const text = m[1]
              if (text.split(' ').length < 2 && text.length < 7) continue
              if (/^[a-z]/.test(text)) continue
              hits.push({ file: p, line: i + 1, kind: pat.name, text: text.slice(0, 90) })
            }
          }
        })
      }
    }
  }
  walk(root)
}
const byFile = new Map()
for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1)
if (filesScanned < MIN_FILES_SCANNED) {
  console.error(
    `scanned only ${filesScanned} file(s) (floor ${MIN_FILES_SCANNED}) — the walk is broken, so a low hit count means nothing. Fix the scan before reading the number below.`
  )
  process.exit(2)
}
console.log(
  `scanned ${filesScanned} files; TOTAL heuristic hits: ${hits.length} across ${byFile.size} files`
)
for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${String(n).padStart(3)}  ${f}`)
}
console.log('\n--- sample 40 (file:line kind | text) ---')
hits.slice(0, 40).forEach((h) => console.log(`${h.file}:${h.line} [${h.kind}] ${h.text}`))
