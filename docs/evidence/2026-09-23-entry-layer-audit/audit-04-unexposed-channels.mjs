#!/usr/bin/env node
// Pass 10: reverse direction — channels main registers handlers for that the renderer surface never
// exposes. Those capabilities can only be reached from main itself (tray/menu/CLI/web/MCP).
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
const exposed = new Set(prev.details.map((d) => d.channel).filter(Boolean))

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}
const files = walk(path.join(ROOT, 'src/main')).filter(
  (f) => !/\.test\.(ts|tsx)$/.test(f) && !/\.test-harness\./.test(f)
)

// channel constant tables: SHARED_CONST = { NAME: 'literal' }
const tables = new Map()
const handledChannels = []
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  const rel = path.relative(ROOT, f)
  for (const m of text.matchAll(/([A-Z][A-Z0-9_]{2,})\s*=\s*'([a-z][a-z0-9-]*(?::[a-z0-9-]+)+)'/g)) {
    tables.set(m[1], m[2])
  }
  for (const m of text.matchAll(/ipcMainHandle\(\s*([^,]+),/g)) {
    handledChannels.push({ file: rel, expr: m[1].trim() })
  }
  for (const m of text.matchAll(/ipcMainHandle\(\s*'([^']+)'/g)) {
    handledChannels.push({ file: rel, channel: m[1] })
  }
}

const resolved = []
for (const h of handledChannels) {
  if (h.channel) {
    resolved.push({ ...h })
    continue
  }
  const expr = h.expr
  const cleaned = expr.replace(/^'/, '').replace(/'$/, '')
  if (cleaned !== expr) {
    resolved.push({ ...h, channel: cleaned })
    continue
  }
  const last = expr.split('.').pop()
  const channel = tables.get(last) ?? tables.get(expr)
  resolved.push({ ...h, channel: channel ?? `?${expr}` })
}

const unexposed = resolved.filter((r) => r.channel && !r.channel.startsWith('?') && !exposed.has(r.channel))
const unknown = resolved.filter((r) => r.channel && r.channel.startsWith('?'))

console.log(`ipcMainHandle registrations: ${resolved.length}  resolved channels: ${resolved.length - unknown.length}`)
console.log(`channels NOT exposed through the renderer contract: ${unexposed.length}`)
for (const r of unexposed) console.log(`  ${r.channel.padEnd(44)} ${r.file}`)
console.log(`\nunresolved expressions: ${unknown.length}`)
for (const r of unknown.slice(0, 20)) console.log(`  ${r.expr}   ${r.file}`)
