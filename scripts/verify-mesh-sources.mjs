#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- same as the other scripts/ tools:
   plain JS has no annotations, and the repo's convention here is to disable rather than to JSDoc-shape
   every callback. */
// Verify every `mesh:<descriptor>` source in the Chinese term table against NLM's own record.
//
// The table claims that each sourced term's English side was READ from a MeSH descriptor, and records the
// descriptor id so a reader can check it. This script is that check, made runnable: it pulls the id out of
// every row, asks NLM for the descriptor, and compares the descriptor's preferred label with the English
// term the row puts on the wire. A row whose English side no longer matches its descriptor — a typo, a
// stale id, a label NLM has since changed — is reported and the run exits non-zero.
//
// What it compares, exactly: the descriptor's PREFERRED LABEL. A row may legitimately send an ENTRY TERM
// instead when that is the English word of record for the Chinese term (MeSH's D019295 is labelled
// "Computational Biology" while "Bioinformatics" is one of its entry terms). Such a row is reported as a
// mismatch here, and that is the point: the deviation is visible and has to be explained in the evidence
// note rather than discovered later by somebody comparing digests.
//
// Deliberately NOT wired into CI: it needs the network, and a lane that fails because a third party is
// slow teaches people to ignore it. Run it when the table changes:
//
//   node scripts/verify-mesh-sources.mjs            # all rows
//   node scripts/verify-mesh-sources.mjs 磁共振成像  # just the named rows (canonical spellings)
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/shared/chinese-terms.ts'), 'utf8')

// meshEntry('磁共振成像', 'procedure', 'magnetic resonance imaging', 'D008279', ['核磁共振']),
const ROW = /meshEntry\(\s*'([^']+)'\s*,\s*'[a-z]+'\s*,\s*'([^']+)'\s*,\s*'(D\d{6,})'/g
const rows = [...source.matchAll(ROW)].map((m) => ({ canonical: m[1], english: m[2], id: m[3] }))

const only = process.argv.slice(2)
const wanted = only.length ? rows.filter((r) => only.includes(r.canonical)) : rows
if (!wanted.length) {
  console.error(only.length ? `No row matches: ${only.join(', ')}` : 'No meshEntry rows found.')
  process.exit(2)
}
// A name that was asked for and is not in the table is reported, never skipped: asking about a row that
// does not exist and getting a quiet "1/1" back reads like a pass for a row nobody checked.
const unknown = only.filter((name) => !rows.some((row) => row.canonical === name))
if (unknown.length) console.error(`Not in the table: ${unknown.join(', ')}`)

/** @returns {Promise<{ label?: string, error?: string }>} The descriptor's preferred label, or why not. */
const labelOf = async (id) => {
  const res = await fetch(`https://id.nlm.nih.gov/mesh/${id}.json`, {
    headers: { accept: 'application/ld+json' }
  })
  if (!res.ok) return { error: `HTTP ${res.status}` }
  const body = await res.json()
  // NLM serves JSON-LD: a plain term comes back as a language-tagged value object ({'@value': '…'}), and
  // some predicates as bare strings. Reading only the string shape reports a confident "0/53 match" for a
  // table that is in fact fine, so both are handled and a missing label stays an explicit error.
  const raw = body?.label ?? body?.['http://www.w3.org/2000/01/rdf-schema#label']
  const label = typeof raw === 'string' ? raw : raw?.['@value']
  return typeof label === 'string' ? { label } : { error: 'no label in response' }
}

let bad = 0
for (const row of wanted) {
  const { label, error } = await labelOf(row.id)
  if (error) {
    bad += 1
    console.log(`?? ${row.canonical}\t${row.id}\t${error}`)
  } else if (label.toLowerCase() !== row.english.toLowerCase()) {
    bad += 1
    console.log(`!! ${row.canonical}\t${row.id}\tsent "${row.english}" but NLM says "${label}"`)
  } else {
    console.log(`ok ${row.canonical}\t${row.id}\t${label}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}

console.log(`\n${wanted.length - bad}/${wanted.length} rows match their MeSH descriptor.`)
process.exit(bad === 0 ? 0 : 1)
