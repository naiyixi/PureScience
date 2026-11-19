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
//
// CLI:
//   node scripts/generate-version-manifest.mjs <artifacts-dir> [version] --github
//     URLs under the release tag (the publish job; the asset the in-app UpdateService polls).
//   node scripts/generate-version-manifest.mjs <artifacts-dir> [version] \
//     --cdn-base <url> [--s3-prefix <prefix>] [--out <path>]
//     URLs under the S3/CDN mirror (the website workflow). The base may also come from
//     CDN_BASE_URL, the prefix from S3_PREFIX, the output path from OUTPUT. A mirrored run with no
//     base at all fails instead of writing download URLs that point nowhere.
//   version defaults to RELEASE_TAG, then GITHUB_REF_NAME (v-prefix stripped).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractChangelogSection } from './release-notes.mjs'

const GITHUB_REPO = 'naiyixi/PureScience'
const HERE = dirname(fileURLToPath(import.meta.url))

// Installer filename -> downloads key (matches electron-builder artifactName templates). The linux
// AppImage spells its arch `x86_64`, not `x64`: electron-builder substitutes `${arch}` from the
// packaging arch, and for AppImage that is the uname form. Checked against every published release
// from v1.75.0 to v2.27.0 (`zerolink-purescience-<v>-linux-x86_64.AppImage` in each). Getting this
// wrong is silent by design — an unrecognized file only warns — so the manifest quietly lost the
// AppImage entry and the client's linux fallback (src/shared/update.ts selectDownload) could never
// fire.
export const INSTALLERS = {
  'mac-arm64': (v) => `zerolink-purescience-${v}-mac-arm64.dmg`,
  'mac-x64': (v) => `zerolink-purescience-${v}-mac-x64.dmg`,
  'win-x64': (v) => `zerolink-purescience-${v}-win-x64-setup.exe`,
  'linux-x64-appimage': (v) => `zerolink-purescience-${v}-linux-x86_64.AppImage`,
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

// The placeholder the client falls back to when a manifest carries no notes. Kept as the last resort
// only: a manifest that ships it makes every installed app send the user to GitHub to learn what
// changed.
export const NOTES_FALLBACK = 'See the release notes on GitHub.'

// The notes for one version's manifest, taken from the CHANGELOG entry that the release page already
// shows, so the in-app "What's new" dialog and the release page cannot disagree. The entry heading is
// dropped (the dialog shows the version itself). An unknown version — a manifest generated by hand
// from a local build — or an entry without a body keeps the GitHub link fallback rather than shipping
// an empty field: an empty notes field renders as "no notes" in the dialog, which reads like a bug.
export const manifestNotes = (version, changelogPath = join(HERE, '..', 'CHANGELOG.md')) => {
  try {
    const section = extractChangelogSection(readFileSync(changelogPath, 'utf8'), version)
    const body = section.split('\n').slice(1).join('\n').trim()
    return body || NOTES_FALLBACK
  } catch {
    return NOTES_FALLBACK
  }
}

// Builds the client manifest for a release directory. `cdnBase`/`prefix` follow the S3 mirror URL
// shape (<cdn>/<prefix>/releases/<version>/<file>); sha256 comes from the dir's SHA256SUMS.txt.
// Missing installers are omitted; a file without a checksum warns and is skipped; zips, checksum/feed
// files and the per-platform certification evidence are ignored silently.
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
  // The publish job's artifacts directory also carries one certification evidence file per platform
  // (`certification-macos-arm64.json`, `certification-windows-update.json`, …). They are not installers,
  // so they used to land in the "unrecognized release file" branch — four harmless warnings on every
  // release. That is not cosmetic: the same branch is the only signal an installer name mismatch gets,
  // and it is exactly how the AppImage entry stayed missing for a dozen releases while the warning was
  // read as routine noise. Recognising them keeps the warning meaning "something is wrong here".
  const isCertificationEvidence = (file) => /^certification-[a-z0-9-]+\.json$/i.test(file)
  const downloads = {}
  for (const file of files) {
    if (file.endsWith('.zip') || file.endsWith('.blockmap') || silent.has(file)) continue
    if (isCertificationEvidence(file)) continue
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
      url: `${cdnBase}${prefix ? `/${prefix}` : ''}/releases/${version}/${file}`,
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
    notes: manifestNotes(version),
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

// A release version: three numeric parts with an optional prerelease/build suffix (`1.76.1`,
// `1.76.1-rc.1`). Deliberately stricter than "any non-empty string", because the failure this guards
// against is a *ref name* being mistaken for a version: on a manual publish the ref being built is the
// branch (`main`), so the manifest was generated for version `main`, matched no installer, and only
// surfaced three steps later as "no installers for version main found in artifacts" (v1.76.1).
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/

// The version this manifest describes, in precedence order:
//  1. the positional argument — the publish job passes the tag its Release is created under;
//  2. `RELEASE_TAG` — the same tag, exported by the publish job, which is the only source that stays
//     correct on a `workflow_dispatch` (there the ref is the branch, and GITHUB_REF_NAME says `main`);
//  3. `GITHUB_REF_NAME` — a tag push, where the ref *is* the release tag (`v1.76.1`).
// A leading `v` is stripped and a non-version candidate is rejected outright rather than silently
// producing a manifest that matches no file.
export const resolveVersion = (argument, env = process.env) => {
  const sources = [
    ['the version argument', argument],
    ['RELEASE_TAG', env.RELEASE_TAG],
    ['GITHUB_REF_NAME', env.GITHUB_REF_NAME]
  ]
  for (const [label, raw] of sources) {
    const rawText = String(raw ?? '').trim()
    if (!rawText) continue
    const candidate = rawText.replace(/^v(?=\d)/, '')
    if (!VERSION_PATTERN.test(candidate)) {
      throw new Error(
        `${label} is not a version number: ${JSON.stringify(rawText)}. Pass the release tag ` +
          '(e.g. 1.76.1) as the version argument, or set RELEASE_TAG to the tag the Release is ' +
          'published under.'
      )
    }
    return candidate
  }
  throw new Error(
    'version required: pass the release tag as an argument, or set RELEASE_TAG (or GITHUB_REF_NAME) to it'
  )
}

// Flags that consume the next argv element. Positional arguments are only the artifacts dir and the
// optional version, so a value-taking flag has to be skipped rather than read as a positional —
// otherwise `--out version.json` makes `version.json` look like the version.
const VALUE_FLAGS = new Set(['--out', '--cdn-base', '--s3-prefix'])

// Splits argv into positionals (dir, version) plus the named options and resolves their defaults.
// Two modes: `--github` writes URLs under the release tag, the mirrored mode needs an explicit base
// (and optional S3 prefix). The mirrored mode refuses to invent a base — a manifest whose download
// URLs point nowhere is worse than a failed job, because the clients reading it are being told
// "update available" at that moment.
export const resolveManifestOptions = (args, env = process.env) => {
  const positionals = []
  const flags = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`)
      }
      flags[arg.slice(2)] = value
      i += 1
    } else if (arg.startsWith('--')) {
      flags[arg.slice(2)] = true
    } else {
      positionals.push(arg)
    }
  }
  const [dir, versionArg] = positionals
  if (!dir) {
    throw new Error(
      'usage: generate-version-manifest.mjs <artifacts-dir> [version] [--github] [--out <path>] ' +
        '[--cdn-base <url>] [--s3-prefix <prefix>]'
    )
  }
  if (positionals.length > 2) {
    throw new Error(`unexpected argument ${JSON.stringify(positionals[2])}`)
  }
  const text = (value) => String(value ?? '').trim()
  const fromFlagOrEnv = (flag, key) =>
    typeof flags[flag] === 'string' ? flags[flag] : text(env[key])
  const github = flags.github === true
  const cdnBase = fromFlagOrEnv('cdn-base', 'CDN_BASE_URL').replace(/\/+$/, '')
  const prefix = fromFlagOrEnv('s3-prefix', 'S3_PREFIX').replace(/^\/+|\/+$/g, '')
  const out = fromFlagOrEnv('out', 'OUTPUT')
  if (!github && !cdnBase) {
    throw new Error(
      'the mirrored manifest needs a download base: pass --cdn-base <url> or set CDN_BASE_URL ' +
        '(use --github for release-asset URLs). Refusing to write a manifest whose download URLs ' +
        'would point nowhere.'
    )
  }
  return { github, dir, versionArg, cdnBase, prefix, out: out || join(dir, 'version.json') }
}

const main = async () => {
  let options
  let version
  try {
    options = resolveManifestOptions(process.argv.slice(2))
    version = resolveVersion(options.versionArg)
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const manifest = options.github
    ? githubManifest(options.dir, version)
    : buildManifest({
        dir: options.dir,
        version,
        notes: manifestNotes(version),
        releaseDate: new Date().toISOString(),
        cdnBase: options.cdnBase,
        prefix: options.prefix
      })
  if (Object.keys(manifest.downloads).length === 0) {
    console.error(`no installers for version ${version} found in ${options.dir}`)
    process.exit(1)
  }
  writeFileSync(options.out, JSON.stringify(manifest, null, 2) + '\n')
  console.log(
    `==> ${options.out}: version=${version} platforms=${Object.keys(manifest.downloads).join(',')}`
  )
}

// CLI entry (only when run directly, not when imported by the mirror workflow or tests).
if (process.argv[1]?.endsWith('generate-version-manifest.mjs')) {
  void main()
}
