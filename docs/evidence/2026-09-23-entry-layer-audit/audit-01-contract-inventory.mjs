#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Audit: which renderer-surface capabilities have no UI entry at all?
import fs from 'node:fs'
import path from 'node:path'
// Entry-layer coverage audit — reproducible helper. Reads the repo it lives in; writes JSON under
// AUDIT_OUT (default: a temp dir) and prints a human-readable report to stdout.
// Run with: node docs/evidence/2026-09-23-entry-layer-audit/<this-file>
import os from 'node:os'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const scratch = process.env.AUDIT_OUT ?? path.join(os.tmpdir(), 'purescience-entry-audit')
fs.mkdirSync(scratch, { recursive: true })

const catalog = fs.readFileSync(path.join(ROOT, 'src/shared/renderer-contract-catalog.ts'), 'utf8')

// Parse: group('capability', 'root', [ ['member', 'channel', PROFILE?], ... ])
const groups = []
const groupRe = /group\(\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*\[([\s\S]*?)\n\s*\]\)/g
let m
while ((m = groupRe.exec(catalog))) {
  const [, capability, root, body] = m
  const members = []
  const entryRe = /\[\s*'([^']+)'\s*,\s*(?:'([^']*)'|null)\s*([^\]]*)\]/g
  let e
  while ((e = entryRe.exec(body))) {
    const tail = e[3] || ''
    const isEvent =
      /\b(EVENT|ELECTRON_EVENT|DORMANT_EVENT|CLOSE_PANE_EVENT|WINDOW_FIND_READY)\b/.test(tail)
    members.push({ member: e[1], channel: e[2] ?? null, isEvent, tail: tail.trim() })
  }
  groups.push({ capability, root, members })
}

const all = []
for (const g of groups) {
  for (const mem of g.members) {
    all.push({
      capability: g.capability,
      root: g.root,
      member: mem.member,
      publicPath: g.root ? `${g.root}.${mem.member}` : mem.member,
      channel: mem.channel,
      isEvent: mem.isEvent,
      tail: mem.tail
    })
  }
}
console.log('groups:', groups.length, 'paths:', all.length)

// Collect renderer source files (non-test) and also test files separately
const rendererDirs = ['src/renderer/src', 'src/renderer/web']
const files = { ui: [], test: [] }
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(entry.name)) {
      const isTest = /\.test\.(ts|tsx)$/.test(entry.name)
      ;(isTest ? files.test : files.ui).push(p)
    }
  }
}
for (const d of rendererDirs) walk(path.join(ROOT, d))

const readAll = (list) => list.map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }))
const uiFiles = readAll(files.ui)
const testFiles = readAll(files.test)
console.log('renderer non-test files:', uiFiles.length, 'test files:', testFiles.length)

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const classify = (p) => {
  const rel = path.relative(ROOT, p.f)
  if (/\/stores\//.test(rel)) return 'store'
  if (/\/hooks\//.test(rel)) return 'hook'
  if (/\/lib\//.test(rel)) return 'lib'
  if (/\.tsx$/.test(rel)) return 'component'
  return 'module'
}

const results = []
for (const item of all) {
  const re = new RegExp(`\\b${esc(item.root)}\\.${esc(item.member)}\\b`, 'g')
  const uiHits = []
  for (const f of uiFiles) {
    const n = (f.text.match(re) || []).length
    if (n) uiHits.push({ file: path.relative(ROOT, f.f), kind: classify(f), n })
  }
  const testHits = []
  for (const f of testFiles) {
    const n = (f.text.match(re) || []).length
    if (n) testHits.push({ file: path.relative(ROOT, f.f), n })
  }
  results.push({ ...item, uiHits, testHits })
}

const noUi = results.filter((r) => r.uiHits.length === 0)
const onlyTest = noUi.filter((r) => r.testHits.length > 0)
const onlyPlumbing = results.filter(
  (r) => r.uiHits.length > 0 && r.uiHits.every((h) => h.kind !== 'component')
)

const out = {
  totals: {
    paths: results.length,
    withUiReference: results.length - noUi.length,
    withoutAnyUiReference: noUi.length,
    withoutUiButWithTest: onlyTest.length,
    noUiNoTest: noUi.length - onlyTest.length,
    referencedOnlyFromPlumbing: onlyPlumbing.length
  },
  noUi: noUi.map((r) => ({
    path: r.publicPath,
    capability: r.capability,
    channel: r.channel,
    kind: r.isEvent ? 'event' : 'method',
    testRefs: r.testHits.length
  })),
  onlyPlumbing: onlyPlumbing.map((r) => ({
    path: r.publicPath,
    refs: r.uiHits.map((h) => `${h.kind}:${h.file}`)
  })),
  details: results
}
fs.writeFileSync(path.join(scratch, 'ui-entry-audit.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out.totals, null, 2))
