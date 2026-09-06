#!/usr/bin/env node
// README.md ↔ README.en.md bilingual sync gate.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
//
// The two files deliberately diverge later (the zh file carries Chinese notes, the en mirror is pure
// English), but the header block — badges, the two intro paragraphs, the release banner — and the
// Zenodo DOI citation must stay byte-identical so the GitHub landing page and the English mirror
// never contradict each other. Run standalone via `node scripts/check-readme-sync.mjs` or as part of
// the pre-push gate.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const read = (name) => readFileSync(resolve(ROOT, name), 'utf8')
const zh = read('README.md')
const en = read('README.en.md')

const failures = []
const equal = (label, a, b) => {
  if (a !== b) failures.push(`${label} 不一致（README.md 与 README.en.md 需逐字相同）`)
}

// 1. Badge block: from the first `[![Download]` to the blank line before the intro paragraph.
const badge = (text) => {
  const start = text.indexOf('[![Download]')
  const end = text.indexOf('\n\n', start)
  return start >= 0 && end > start ? text.slice(start, end) : ''
}
equal('徽章块', badge(zh), badge(en))

// 2. Intro paragraphs: everything between the badge block and the release banner line.
const intro = (text) => {
  const start = text.indexOf('\n\n', text.indexOf('[![Download]')) + 2
  const end = text.indexOf('> 💡 **[PureScience v')
  return start >= 0 && end > start ? text.slice(start, end).trim() : ''
}
equal('引言段落', intro(zh), intro(en))

// 3. Release banner line (version token is checked separately against package.json by the caller).
const banner = (text) => {
  const line = text.split('\n').find((l) => l.startsWith('> 💡 **[PureScience v'))
  return line ?? ''
}
equal('发布横幅行', banner(zh), banner(en))

// 4. Zenodo DOI citation lines (zh file carries one in its body; both must mention the same DOI).
const dois = (text) => [...text.matchAll(/10\.5281\/zenodo\.\d+/g)].map((m) => m[0])
const zhDois = [...new Set(dois(zh))]
const enDois = [...new Set(dois(en))]
if (zhDois.join(',') !== enDois.join(',')) {
  failures.push(`DOI 引用不一致（zh=${zhDois.join(',')} en=${enDois.join(',')}）`)
}

if (failures.length > 0) {
  console.error('[readme-sync] ✗\n  ' + failures.join('\n  '))
  process.exit(1)
}
console.log('[readme-sync] ✓ README 双语头部锚点（徽章/引言/横幅/DOI）逐字一致')
