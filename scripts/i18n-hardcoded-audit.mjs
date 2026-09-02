// Dev audit: surface user-visible English literals that bypass t().
// Pure-Node scan; heuristic patterns; no CI gate (drives the keying backlog).
// Usage: node scripts/i18n-hardcoded-audit.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['src/renderer/src', 'src/main']
const EXT = new Set(['.tsx', '.ts'])

const patterns = [
  { name: 'attr literal', re: /(?:aria-label|title|placeholder)="([A-Za-z][A-Za-z0-9 ,.&/():'’_%+–-]{5,})"/g },
  { name: 'jsx-text', re: />([A-Za-z][A-Za-z0-9 ,.&/():'’_%+–-]{8,})</g },
  { name: 'dquote', re: /"([A-Z][a-z]+ [A-Za-z0-9 ,.&/():'’_%+–-]{6,})"/g }
]

const skip = /(test|spec)\.(ts|tsx)$/
const ignoreLine = (ln) => /t\(|useLanguage|eslint-disable|aria-hidden|console\.|\.css|import |require\(|http|https|\/\/|language.*'|style=/.test(ln)

const hits = []
for (const root of ROOTS) {
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (EXT.has(extname(p)) && !skip.test(e)) {
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
console.log(`TOTAL heuristic hits: ${hits.length} across ${byFile.size} files`)
for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${String(n).padStart(3)}  ${f}`)
}
console.log('\n--- sample 40 (file:line kind | text) ---')
hits.slice(0, 40).forEach((h) => console.log(`${h.file}:${h.line} [${h.kind}] ${h.text}`))
