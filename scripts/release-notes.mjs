#!/usr/bin/env node
// Compose the GitHub Release body for a version out of the repository's own sources.
//
// Why this exists: GitHub's generated notes are a list of PR titles. The release workflow is the protected
// CI control plane, so the page users land on from an update prompt cannot carry the maturity
// self-statement or the known limitations — even though those are exactly what somebody deciding whether
// to install needs. This script takes the maturity block from README.en.md and the entry from
// CHANGELOG.md, so the release page cannot drift from the repository, and keeps whatever generated notes
// it finds so the PR list is not lost.
//
// It also carries the macOS signing disclosure (issue #19): when this release's
// RELEASE-CERTIFICATION.json says the mac assets are unsigned (or the state was never established), the
// page has to say so — otherwise a green notarize job reads as "notarized". The line is re-derived from
// that record on every run and, when the record is unavailable, an existing disclosure in the current
// body is kept verbatim, so a rewrite of this page can never silently drop the fact.
//
// Usage:
//   node scripts/release-notes.mjs 1.68.0 --print            # preview (default)
//   node scripts/release-notes.mjs v1.68.0 --keep-generated  # preview, keeping the generated notes tail
//   node scripts/release-notes.mjs v1.68.0 --apply           # write the body to the GitHub release
//   node scripts/release-notes.mjs v1.68.0 --certification RELEASE-CERTIFICATION.json
//
// Re-running is safe: the body is replaced wholesale by freshly composed content, never appended to.
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  MAC_SIGNING_DISCLOSURE_MARKER,
  macSigningDisclosureFromRecord
} from './ci/mac-signing-status.mjs'

const MATURITY_HEADING = '## Maturity and Known Limitations'
const GENERATED_MARKERS = ["## What's Changed", '**Full Changelog**']

// The CHANGELOG entry for one version: from its heading up to the next version heading.
export function extractChangelogSection(changelog, version) {
  const wanted = String(version).replace(/^v/, '')
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## v${wanted}`))
  if (start < 0) throw new Error(`CHANGELOG.md has no section for v${wanted}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## v\d/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

// The maturity block from a README: the heading through the last line before the release banner or the
// next `## ` heading. The banner names a version and the page furniture after it (title image, table of
// contents) belongs to the landing page — neither belongs in a release body, so the block ends there.
export function extractMaturityBlock(readme) {
  const lines = readme.split('\n')
  const start = lines.findIndex((line) => line.trim() === MATURITY_HEADING)
  if (start < 0) throw new Error(`README has no "${MATURITY_HEADING}" section`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('> 💡 **[') || lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

// Order matters: what is verified, then the mac signing fact, then what changed, then the generated
// PR list. The disclosure sits directly under the maturity block so a reader cannot reach the
// download links (or an update prompt) without passing it.
export function composeReleaseBody({ maturity, changelog, generated = '', disclosure = '' }) {
  const parts = [maturity.trim()]
  if (String(disclosure).trim()) parts.push(String(disclosure).trim())
  parts.push(changelog.trim())
  if (generated.trim()) parts.push(generated.trim())
  return `${parts.join('\n\n---\n\n')}\n`
}

// Keep the PR list from the body GitHub generated, so --apply does not throw it away.
export function extractGeneratedTail(body) {
  const lines = body.split('\n')
  const start = lines.findIndex((line) =>
    GENERATED_MARKERS.some((marker) => line.startsWith(marker))
  )
  if (start < 0) return ''
  return lines.slice(start).join('\n').trim()
}

// The macOS signing disclosure already on the page, as composed by
// scripts/ci/mac-signing-status.mjs. Kept verbatim when the certification record cannot be read: the
// fact is machine-derived from the certification record, so a rewrite must be able to
// preserve it but never invent one.
export function extractMacSigningDisclosure(body) {
  const lines = String(body ?? '').split('\n')
  return lines.find((line) => line.startsWith(MAC_SIGNING_DISCLOSURE_MARKER))?.trim() ?? ''
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options }).trim()
}

function main() {
  const argv = process.argv.slice(2)
  const version = argv.find((arg) => !arg.startsWith('--'))
  const keepGenerated = argv.includes('--keep-generated')
  const apply = argv.includes('--apply')
  if (!version) {
    console.error('usage: release-notes.mjs <version|tag> [--keep-generated] [--apply]')
    process.exit(1)
  }
  const argument = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const tag = `v${version.replace(/^v/, '')}`
  const root = resolve(new URL('..', import.meta.url).pathname)
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const readme = readFileSync(join(root, 'README.en.md'), 'utf8')

  // The current body is read once and reused: --keep-generated keeps the PR list from it, and the
  // macOS disclosure is preserved from it when no certification record can be read. --apply reads it
  // for the same reason (it used to be dropped wholesale), so a rewrite can never lose the fact.
  let currentBody
  const readCurrentBody = () => {
    if (currentBody !== undefined) return currentBody
    currentBody = ''
    try {
      currentBody = gh(['release', 'view', tag, '--json', 'body', '--jq', '.body'])
    } catch (error) {
      console.error(`release-notes: could not read the current body for ${tag}: ${error.message}`)
    }
    return currentBody
  }

  let generated = ''
  if (keepGenerated) generated = extractGeneratedTail(readCurrentBody())
  const disclosure = resolveMacSigningDisclosure({ tag, readCurrentBody, argument })

  const body = composeReleaseBody({
    maturity: extractMaturityBlock(readme),
    changelog: extractChangelogSection(changelog, version),
    generated,
    disclosure
  })
  if (!apply) {
    process.stdout.write(body)
    return
  }
  const file = join(tmpdir(), `purescience-release-notes-${tag}.md`)
  writeFileSync(file, body)
  const out = gh(['release', 'edit', tag, '--notes-file', file])
  console.log(`release-notes: wrote ${body.length} chars into ${tag}${out ? ` (${out})` : ''}`)
}

// The macOS signing fact comes from the machine-readable record the release published — never from
// prose. An unreadable/absent record keeps whatever disclosure the page already carries (verbatim),
// so the two failure modes are impossible: claiming signed, and silently dropping the fact.
function resolveMacSigningDisclosure({ tag, readCurrentBody, argument }) {
  const explicitPath = argument('--certification')
  const record = explicitPath ? readJsonIfPossible(explicitPath) : readCertificationRecord(tag)

  if (record) {
    const derived = macSigningDisclosureFromRecord(record)
    console.log(
      `release-notes: macOS signing disclosure ${derived ? 'required' : 'not required'} ` +
        `(RELEASE-CERTIFICATION.json for ${tag})`
    )
    return derived ?? ''
  }

  const preserved = extractMacSigningDisclosure(readCurrentBody())
  if (preserved) {
    console.error(
      `release-notes: no certification record for ${tag} — keeping the existing macOS signing ` +
        'disclosure verbatim'
    )
  }
  return preserved
}

function readJsonIfPossible(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`release-notes: cannot read ${path}: ${error.message}`)
    return undefined
  }
}

// The record is a release asset, so it is fetched from the tag itself: the page cannot disagree with
// the artifact it publishes. Absent for releases cut before the record carried the mac state.
function readCertificationRecord(tag) {
  const directory = mkdtempSync(join(tmpdir(), 'purescience-certification-'))
  try {
    gh([
      'release',
      'download',
      tag,
      '--pattern',
      'RELEASE-CERTIFICATION.json',
      '--dir',
      directory,
      '--clobber'
    ])
  } catch {
    return undefined
  }
  return readJsonIfPossible(join(directory, 'RELEASE-CERTIFICATION.json'))
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main()
}
