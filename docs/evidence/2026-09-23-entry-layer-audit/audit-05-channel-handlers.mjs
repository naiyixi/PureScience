#!/usr/bin/env node
// Pass 9: does every channel the preload exposes actually have a main-process handler?
// A path in window.api with no handler in main is a promise the app cannot keep.
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

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}
const main = walk(path.join(ROOT, 'src/main'))
  .filter((f) => !/\.test\.(ts|tsx)$/.test(f) && !/\.test-harness\./.test(f))
  .map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }))
const shared = walk(path.join(ROOT, 'src/shared'))
  .filter((f) => !/\.test\.ts$/.test(f))
  .map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }))

// channel constant tables in shared/ and main/
const constantText = [...main, ...shared].map((f) => f.text).join('\n')
const mainText = main.map((f) => f.text).join('\n')

const rows = []
for (const item of prev.details) {
  const ch = item.channel
  if (!ch) continue
  const literalInMain = mainText.includes(`'${ch}'`) || mainText.includes(`"${ch}"`)
  // also allow channel constants: e.g. `NAME: 'x'` in a table then used via the constant
  rows.push({ path: item.publicPath, channel: ch, literalInMain })
}
const missing = rows.filter((r) => !r.literalInMain)
console.log(`channels: ${rows.length}   literal not found in main non-test sources: ${missing.length}`)
for (const r of missing) console.log(`  ${r.path.padEnd(44)} ${r.channel}`)
fs.writeFileSync(path.join(scratch, 'channel-handler-check.json'), JSON.stringify(rows, null, 2))
