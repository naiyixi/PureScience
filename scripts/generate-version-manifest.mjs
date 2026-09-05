#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Generates the version.json client manifest for a release's installers.
//
// Two consumers share this script:
//  1. The website mirror (S3 CDN): buildManifest() is exported for the mirror workflow, which
//     publishes version.json under <cdn>/<prefix>/releases/<version>/.
//  2. GitHub Releases: CLI mode `node generate-version-manifest.mjs <dir> [version] --github`
//     publishes the same manifest to <repo>/releases/latest/download/version.json (the asset the
//     in-app UpdateService polls). Without that asset every manifest-flow client sees
//     "Manifest fetch failed: 404" on check-for-updates; stable in-place clients use the
//     electron-updater feeds instead.
//
// sha256 values come from the release's own SHA256SUMS.txt; every installer present in the
// directory becomes a downloads entry keyed by the client's platformDownloadKey() values.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GITHUB_REPO = 'naiyixi/PureScience'

// Installer filename -> downloads key (matches electron-builder artifactName templates).
export const INSTALLERS = {
  'mac-arm64': (v) => `zerolink-purescience-${v}-mac-arm64.dmg`,
  'mac-x64': (v) => `zerolink-purescience-${v}-mac-x64.dmg`,
  'win-x64': (v) => `zerolink-purescience-${v}-win-x64-setup.exe`,
  'linux-x64-appimage': (v) => `zerolink-purescience-${v}-linux-x64.AppImage`,
  'linux-x64-deb': (v) => `zerolink-purescience_${v}_amd64.deb`
}

// Release-note sections kept for the in-app notes (everything else is dropped).
const HIGHLIGHT_SECTIONS = ['✨ Highlights', '🚀 New Features', '🔧 Improvements', '🐛 Bug Fixes']

// Parses a SHA256SUMS.txt body into { filename: lowercase-hex }. Handles the optional binary-mode
// `*` marker and ignores junk lines.
export const parseSha256Sums = (text) => {
  const map = {}
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (!match) continue
    map[match[2].trim()] = match[1].toLowerCase()
  }
  return map
}

// Extracts the release-notes highlights for the in-app update dialog: keeps only the allowlisted
// sections in document order. Blank bodies return ''; when no allowlisted section exists, falls
// back to the preamble (everything before the first heading, minus the H1 title line).
export const extractHighlights = (body) => {
  const text = String(body ?? '')
  if (!text.trim()) return ''
  const lines = text.split('\n')
  const sections = []
  let current = null
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      current = { title: heading[1].trim(), body: [] }
      sections.push(current)
    } else if (current) {
      current.body.push(line)
    }
  }
  const kept = sections.filter((section) =>
    HIGHLIGHT_SECTIONS.some((name) => section.title === name)
  )
  if (kept.length > 0) {
    return kept.map((section) => `## ${section.title}\n${section.body.join('\n')}`).join('\n')
  }
  // Fallback: preamble before the first section heading, minus the H1 title.
  const firstHeading = lines.findIndex((line) => /^#/.test(line) && !line.startsWith('##'))
  const start = firstHeading === -1 ? 0 : firstHeading + 1
  const preamble = lines.slice(start).join('\n')
  const withoutH1 = preamble.replace(/^#\s+[^\n]+\n?/, '')
  return withoutH1.trim()
}

// Builds the client manifest for a release directory. `cdnBase`/`prefix` follow the S3 mirror URL
// shape (<cdn>/<prefix>/releases/<version>/<file>); sha256 comes from the dir's SHA256SUMS.txt.
// Missing installers are omitted; a file without a checksum warns and is skipped; zips and
// checksum/feed files are ignored silently.
export const buildManifest = ({ dir, version, notes, releaseDate, cdnBase, prefix }) => {
  const files = readdirSync(dir)
  const sums = parseSha256Sums(
    files.includes('SHA256SUMS.txt')
      ? readFileSync(join(dir, 'SHA256SUMS.txt')).toString('utf8')
      : ''
  )
  const silent = new Set([
    'SHA256SUMS.txt',
    'RELEASE-CERTIFICATION.json',
    'version.json',
    'latest.yml',
    'latest-linux.yml',
    'latest-mac.yml',
    'arm64-mac.yml',
    'x64-mac.yml'
  ])
  const downloads = {}
  for (const file of files) {
    if (file.endsWith('.zip') || file.endsWith('.blockmap') || silent.has(file)) continue
    const key = Object.keys(INSTALLERS).find((k) => INSTALLERS[k](version) === file)
    if (!key) {
      console.warn(`warn: unrecognized release file ${file}`)
      continue
    }
    const sha = sums[file]
    if (!sha) {
      console.warn(`warn: ${file} has no sha256 in SHA256SUMS.txt`)
      continue
    }
    downloads[key] = {
      url: `${cdnBase}/${prefix}/releases/${version}/${file}`,
      size: statSync(join(dir, file)).size,
      sha256: sha
    }
  }
  return { version, notes, releaseDate, downloads }
}

const githubManifest = (dir, version) => {
  // Reuse buildManifest's key/checksum logic via a temp prefix shape, then rewrite URLs for the
  // GitHub Releases asset layout (<repo>/releases/download/<tag>/<file>).
  const built = buildManifest({
    dir,
    version,
    notes: 'See the release notes on GitHub.',
    releaseDate: new Date().toISOString(),
    cdnBase: '',
    prefix: ''
  })
  const tag = `v${version}`
  const downloads = {}
  for (const [key, entry] of Object.entries(built.downloads)) {
    const file = entry.url.split('/').pop()
    downloads[key] = {
      url: `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${file}`,
      size: entry.size,
      sha256: entry.sha256
    }
  }
  return { ...built, downloads }
}

const main = async () => {
  const args = process.argv.slice(2)
  const github = args.includes('--github')
  const dir = args.find((a) => !a.startsWith('--'))
  const versionArg = args.filter((a) => !a.startsWith('--') && a !== dir)[0]
  if (!dir) {
    console.error('usage: generate-version-manifest.mjs <artifacts-dir> [version] [--github]')
    process.exit(1)
  }
  const ref = process.env.GITHUB_REF_NAME ?? ''
  const version = versionArg?.trim() || (ref.startsWith('v') ? ref.slice(1) : ref)
  if (!version) {
    console.error('version required (argument or GITHUB_REF_NAME)')
    process.exit(1)
  }
  const manifest = github
    ? githubManifest(dir, version)
    : buildManifest({
        dir,
        version,
        notes: 'See the release notes on GitHub.',
        releaseDate: new Date().toISOString(),
        cdnBase: 'https://github.com/naiyixi/PureScience/releases/download',
        prefix: ''
      })
  if (Object.keys(manifest.downloads).length === 0) {
    console.error(`no installers for version ${version} found in ${dir}`)
    process.exit(1)
  }
  const out = join(dir, 'version.json')
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')
  console.log(
    `==> ${out}: version=${version} platforms=${Object.keys(manifest.downloads).join(',')}`
  )
}

// CLI entry (only when run directly, not when imported by the mirror workflow or tests).
if (process.argv[1]?.endsWith('generate-version-manifest.mjs')) {
  void main()
}
