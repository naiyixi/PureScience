#!/usr/bin/env node
// Pass 3: global bare-member search across renderer (any object), with per-hit evidence.
// Rationale: stores receive a commands object (getCommands: () => window.api.<root>) so the
// root prefix never appears at the call site. Bare member search is the reliable signal;
// generic member names are flagged for manual review.
import fs from 'node:fs'
import path from 'node:path'
// Entry-layer coverage audit — reproducible helper. Reads the repo it lives in; writes JSON under
// AUDIT_OUT (default: a temp dir) and prints a human-readable report to stdout.
// Run with: node docs/evidence/2026-09-23-entry-layer-audit/<this-file>
import os from 'node:os'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const scratch = process.env.AUDIT_OUT ?? path.join(os.tmpdir(), 'purescience-entry-audit')
fs.mkdirSync(scratch, { recursive: true })

const prev = JSON.parse(fs.readFileSync(path.join(scratch, 'ui-entry-audit.json'), 'utf8'))

const walkFiles = (dirs) => {
  const out = { ui: [], test: [] }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name)) (/\.test\.(ts|tsx)$/.test(e.name) ? out.test : out.ui).push(p)
    }
  }
  for (const d of dirs) walk(path.join(ROOT, d))
  return out
}
const { ui, test } = walkFiles(['src/renderer/src', 'src/renderer/web'])
const load = (l) => l.map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }))
const uiFiles = load(ui)
const testFiles = load(test)

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const GENERIC = new Set(['list', 'get', 'open', 'cancel', 'remove', 'set', 'save', 'update', 'close', 'run', 'delete', 'add', 'start', 'stop', 'getInfo', 'getState', 'getStatus', 'status', 'ready', 'onChanged', 'refresh', 'clear', 'reset'])

const classify = (rel) => {
  if (/\/stores\//.test(rel)) return 'store'
  if (/\/hooks\//.test(rel)) return 'hook'
  if (/\/lib\//.test(rel)) return 'lib'
  if (/\.tsx$/.test(rel)) return 'component'
  return 'module'
}

const out = []
for (const item of prev.details) {
  const directRe = new RegExp(`\\b${esc(item.root)}\\.${esc(item.member)}\\b`)
  const bareRe = new RegExp(`\\.${esc(item.member)}\\b`, 'g')
  const direct = []
  const bare = []
  for (const f of uiFiles) {
    if (directRe.test(f.text)) direct.push({ file: f.file, kind: classify(f.file) })
    const n = (f.text.match(bareRe) || []).length
    if (n) bare.push({ file: f.file, kind: classify(f.file), n })
  }
  const testBare = testFiles.filter((f) => bareRe.test(f.text)).map((f) => f.file)
  out.push({ ...item, direct, bare, testBare })
}

const referenced = out.filter((r) => r.direct.length || r.bare.length)
const absent = out.filter((r) => !r.direct.length && !r.bare.length)
const absentTestOnly = absent.filter((r) => r.testBare.length)
const bareNoComponent = out.filter(
  (r) => r.bare.length && !r.bare.some((h) => h.kind === 'component') && !r.direct.some((h) => h.kind === 'component')
)

fs.writeFileSync(path.join(scratch, 'ui-entry-audit3.json'), JSON.stringify({ out }, null, 2))
console.log(
  JSON.stringify(
    {
      total: out.length,
      referenced: referenced.length,
      absentFromRenderer: absent.length,
      absentButInTests: absentTestOnly.length,
      referencedOnlyFromPlumbing: bareNoComponent.length
    },
    null,
    2
  )
)
console.log('\n=== ABSENT (no .member call anywhere in renderer non-test) ===')
for (const r of absent) {
  console.log(
    `${r.publicPath.padEnd(46)} ${String(r.channel).padEnd(44)} ${(r.isEvent ? 'event' : 'method').padEnd(6)} ${GENERIC.has(r.member) ? 'GENERIC-NAME' : ''}${r.testBare.length ? ' test-only' : ''}`
  )
}
console.log('\n=== REFERENCED ONLY FROM NON-COMPONENT (store/hook/lib) ===')
for (const r of bareNoComponent) {
  const kinds = [...new Set(r.bare.map((h) => h.kind))].join(',')
  console.log(`${r.publicPath.padEnd(46)} ${kinds.padEnd(20)} ${r.bare.map((h) => h.file).slice(0, 2).join(' | ')}`)
}
