#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Pass 6: for a given root, list which members ARE called in the renderer and where — so a group can
// be read as "backend has N verbs, UI reaches M of them".
import fs from 'node:fs'
import path from 'node:path'
// Entry-layer coverage audit — reproducible helper. Reads the repo it lives in; writes JSON under
// AUDIT_OUT (default: a temp dir) and prints a human-readable report to stdout.
// Run with: node docs/evidence/2026-09-23-entry-layer-audit/<this-file>
import os from 'node:os'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const scratch = process.env.AUDIT_OUT ?? path.join(os.tmpdir(), 'purescience-entry-audit')
fs.mkdirSync(scratch, { recursive: true })

const cat = fs.readFileSync(path.join(ROOT, 'src/shared/renderer-contract-catalog.ts'), 'utf8')

const groups = new Map()
for (const m of cat.matchAll(/group\(\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*\[([\s\S]*?)\n\s*\]\)/g)) {
  const members = [...m[3].matchAll(/\[\s*'([^']+)'\s*,\s*(?:'([^']*)'|null)/g)].map((x) => x[1])
  groups.set(m[2], { capability: m[1], members })
}

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}
const files = walk(path.join(ROOT, 'src/renderer/src'))
  .concat(walk(path.join(ROOT, 'src/renderer/web')))
  .concat(walk(path.join(ROOT, 'resources/find-overlay')))
  .map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }))

const targets = process.argv.slice(2)
for (const root of targets) {
  const g = groups.get(root)
  if (!g) {
    console.log(`\n## ${root}: (not a group root)`)
    continue
  }
  console.log(`\n## ${root}  (${g.capability})  backend verbs: ${g.members.length}`)
  for (const member of g.members) {
    const re = new RegExp(`\\.${member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    const hits = []
    for (const f of files) {
      if (re.test(f.text))
        hits.push(f.rel.replace('src/renderer/src/', '').replace('src/renderer/', ''))
    }
    const mark = hits.length ? '✔' : '✗'
    console.log(`  ${mark} ${member.padEnd(34)} ${hits.slice(0, 3).join(', ')}`)
  }
}
