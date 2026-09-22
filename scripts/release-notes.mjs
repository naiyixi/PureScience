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
// Usage:
//   node scripts/release-notes.mjs 1.68.0 --print            # preview (default)
//   node scripts/release-notes.mjs v1.68.0 --keep-generated  # preview, keeping the generated notes tail
//   node scripts/release-notes.mjs v1.68.0 --apply           # write the body to the GitHub release
//
// Re-running is safe: the body is replaced wholesale by freshly composed content, never appended to.
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

// Order matters: what is verified, then what changed, then the generated PR list.
export function composeReleaseBody({ maturity, changelog, generated = '' }) {
  const parts = [maturity.trim(), changelog.trim()]
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
  const tag = `v${version.replace(/^v/, '')}`
  const root = resolve(new URL('..', import.meta.url).pathname)
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const readme = readFileSync(join(root, 'README.en.md'), 'utf8')
  let generated = ''
  if (keepGenerated) {
    try {
      generated = extractGeneratedTail(
        gh(['release', 'view', tag, '--json', 'body', '--jq', '.body'])
      )
    } catch (error) {
      console.error(
        `release-notes: could not read the generated notes for ${tag}: ${error.message}`
      )
    }
  }
  const body = composeReleaseBody({
    maturity: extractMaturityBlock(readme),
    changelog: extractChangelogSection(changelog, version),
    generated
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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main()
}
