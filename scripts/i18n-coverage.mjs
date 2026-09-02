#!/usr/bin/env node
// i18n coverage report — parses the TS dictionary files under src/renderer/src/i18n and prints the
// per-language key coverage vs English. Exit code is 0 unless `--min <pct>` is given and a language
// falls below the threshold. Usage: node scripts/i18n-coverage.mjs [--min 99.5]
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const i18nDir = resolve(here, '../src/renderer/src/i18n')
const DICTIONARIES = ['en', 'zh', 'zh-Hant', 'ja', 'ko', 'fr', 'de', 'es', 'ru']

const readKeys = (name) => {
  const text = readFileSync(resolve(i18nDir, `${name}.ts`), 'utf8')
  return new Set([...text.matchAll(/^\s*'([\w.-]+)':/gm)].map((match) => match[1]))
}

const minArgIndex = process.argv.indexOf('--min')
const min = minArgIndex >= 0 ? Number(process.argv[minArgIndex + 1]) : undefined

const enKeys = readKeys('en')
const rows = DICTIONARIES.map((name) => {
  if (name === 'en') return { name, count: enKeys.size, coverage: 100 }
  const keys = readKeys(name)
  const covered = [...keys].filter((key) => enKeys.has(key)).length
  return { name, count: keys.size, coverage: (covered / enKeys.size) * 100 }
})

console.log(`en source keys: ${enKeys.size}`)
for (const row of rows) {
  const bar = row.name === 'en' ? '─' : '░'.repeat(Math.max(1, Math.round(row.coverage / 4)))
  console.log(
    `${row.name.padEnd(8)} keys=${String(row.count).padStart(5)}  coverage=${row.coverage.toFixed(1).padStart(5)}%  ${bar}`
  )
}

const failures = min === undefined ? [] : rows.filter((row) => row.coverage < min)
if (failures.length > 0) {
  console.error(`\nFAIL: coverage below ${min}%: ${failures.map((row) => row.name).join(', ')}`)
  process.exit(1)
}
console.log(min === undefined ? '\nOK (report only)' : `\nOK (all >= ${min}%)`)
