/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Build — and gate — the single macOS update feed an installed app polls: `latest-mac.yml`.
//
// Why this exists: arm64 and x64 build on separate runners and both keep the update channel
// `latest` (so the packaged app-update.yml names a feed the updater actually polls), which means
// each runner writes a feed called `latest-mac.yml` for its own arch. Two same-named files coming
// from two artifacts collapse into one in the publish job's flattened download; the combined feed
// that lists both arch zips is what lets MacUpdater.filterFilesForArch pick the right one per arch.
//
// The AUTHORITATIVE input is the ZIP BYTES the release is about to ship: sha512 (base64) and size are
// computed from each arch's zip, so the feed can never describe bytes other than those attached to
// the release. A per-arch feed (`<arch>-mac.yml`, written by notarize-mac.yml over the STAPLED zip)
// is used only as a fallback for an arch whose zip is not in the directory — the standalone
// release-repair path downloads the two small feeds rather than ~600 MB of zips. Deriving from the
// artifacts is what makes the result independent of steps that may no-op: notarize-mac.yml skips
// every real step when APPLE_API_KEY_P8_BASE64 is unset, and that is exactly when the previous
// version of this script went silent (`both per-arch feeds not present, skipping`), so v1.75.0
// published a feed that listed only `-mac-x64.*` (issue #18).
//
// Usage:
//   node scripts/merge-mac-feed.mjs <dir>                 write <dir>/latest-mac.yml, failing closed
//                                                        unless BOTH arches resolve
//   node scripts/merge-mac-feed.mjs <dir> --verify         gate: re-read <dir>/latest-mac.yml and
//                                                        require an arm64 and an x64 zip entry, each
//                                                        with a sha512 and a size (and, when that zip
//                                                        is on disk, a matching sha512/size)
//   node scripts/merge-mac-feed.mjs <dir> --allow-missing  tolerate NO mac material at all (the
//                                                        release-repair backfill for a non-mac or
//                                                        pre-feed release); never a partial one
// Exit code 0 = the feed is complete for both architectures, 1 = it is not.
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAC_ARCHES = ['arm64', 'x64']
export const MAC_FEED_FILE = 'latest-mac.yml'

// `zerolink-purescience-1.75.0-mac-arm64.zip` and the nightly form
// `zerolink-purescience-1.76.0-nightly.g1a2b3c4-mac-x64.zip`.
const RELEASE_VERSION = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-mac-/
const ARCH_ZIP = Object.fromEntries(
  MAC_ARCHES.map((arch) => [arch, new RegExp(`-mac-${arch}\\.zip$`)])
)
const perArchFeed = (arch) => `${arch}-mac.yml`

// electron-updater writes sha512 as base64 of the raw digest (64 bytes -> 88 chars, `==`-padded).
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/

// Streamed so a ~300 MB zip never has to be held in memory (this job runs on a 2-core runner).
export const sha512Base64 = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
  })

const unquote = (value) => value.replace(/^['"]|['"]$/g, '').trim()

// Read the `files:` entries out of an electron-updater feed WITHOUT a YAML dependency: the publish
// job only checks the repo out (no `npm ci`), so js-yaml is not importable there. Both known writers
// — electron-builder's build-time feed (one entry per mac artifact: zip then dmg) and
// notarize-mac.yml's regenerated per-arch intermediate (zip only) — emit `- url:` with indented
// `sha512:`/`size:` fields, which is what this walks. The block ends at the next unindented line, so
// the legacy top-level `path:`/`sha512:` pair never overwrites the last entry.
export const parseMacFeed = (text) => {
  const source = String(text)
  const version = unquote(source.match(/^version:\s*(.+)$/m)?.[1] ?? '')
  const releaseDate = unquote(source.match(/^releaseDate:\s*(.+)$/m)?.[1] ?? '')
  const entries = []
  let inFiles = false
  for (const line of source.split(/\r?\n/)) {
    if (!inFiles) {
      if (/^files:\s*$/.test(line)) inFiles = true
      continue
    }
    if (line.trim() !== '' && !/^\s/.test(line)) break
    const url = line.match(/^\s+-\s+url:\s*(.+?)\s*$/)
    if (url) {
      entries.push({ url: unquote(url[1]) })
      continue
    }
    const entry = entries[entries.length - 1]
    if (!entry) continue
    const sha512 = line.match(/^\s+sha512:\s*(\S+)\s*$/)
    if (sha512) entry.sha512 = unquote(sha512[1])
    const size = line.match(/^\s+size:\s*(\d+)\s*$/)
    if (size) entry.size = Number(size[1])
  }
  return { version: version || undefined, releaseDate: releaseDate || undefined, entries }
}

// Resolve one feed entry per arch: from the published zip's own bytes when the zip is present,
// otherwise from that arch's per-arch feed. Never throws for a merely missing arch — the caller
// decides whether that is fatal (publish) or expected (a non-mac repair backfill).
export const resolveMacFeedInputs = async (dir) => {
  const names = readdirSync(dir)
  const entries = {}
  const usedFeeds = []
  const problems = []

  for (const arch of MAC_ARCHES) {
    const zips = names.filter((name) => ARCH_ZIP[arch].test(name)).sort()
    if (zips.length > 1) {
      problems.push(
        `${arch}: ${zips.length} candidate zips in ${dir} (${zips.join(', ')}) — exactly one is expected`
      )
      continue
    }
    if (zips.length === 1) {
      const [zip] = zips
      const { size } = statSync(join(dir, zip))
      entries[arch] = {
        url: zip,
        sha512: await sha512Base64(join(dir, zip)),
        size,
        source: `bytes of ${zip}`
      }
      continue
    }

    const feedName = perArchFeed(arch)
    if (!existsSync(join(dir, feedName))) {
      problems.push(`${arch}: no *-mac-${arch}.zip in ${dir} and no ${feedName} to fall back to`)
      continue
    }
    const feed = parseMacFeed(readFileSync(join(dir, feedName), 'utf8'))
    usedFeeds.push(feed)
    const entry = feed.entries.find((candidate) => ARCH_ZIP[arch].test(String(candidate.url ?? '')))
    if (!entry || !entry.sha512 || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
      problems.push(
        `${arch}: ${feedName} carries no complete -mac-${arch}.zip entry (url + sha512 + size)`
      )
      continue
    }
    entries[arch] = { url: entry.url, sha512: entry.sha512, size: entry.size, source: feedName }
  }

  // Every input has to name the same release: a stale per-arch feed from an earlier version would
  // otherwise be merged into a feed the updater compares against the running version.
  const versions = new Set()
  for (const arch of Object.keys(entries)) {
    const match = entries[arch].url.match(RELEASE_VERSION)
    if (match) versions.add(match[1])
  }
  for (const feed of usedFeeds) if (feed.version) versions.add(feed.version)
  if (versions.size > 1) {
    problems.push(`version mismatch across the mac artifacts: ${[...versions].sort().join(' vs ')}`)
  }
  const version = [...versions].sort()[0]
  if (!version) {
    problems.push(`could not read a release version from the mac artifact names in ${dir}`)
  }

  const releaseDate = usedFeeds
    .map((feed) => feed.releaseDate)
    .filter(Boolean)
    .sort()
    .pop()

  return { version, releaseDate, entries, problems }
}

// Zip entries in a fixed arch order, so the file is byte-identical between runs on the same inputs.
export const buildMacFeedText = ({ version, entries, releaseDate }) => {
  const ordered = MAC_ARCHES.map((arch) => entries[arch]).filter(Boolean)
  const filesYaml = ordered
    .map((entry) => `  - url: ${entry.url}\n    sha512: ${entry.sha512}\n    size: ${entry.size}`)
    .join('\n')
  // Top-level path/sha512 are legacy single-file fields; MacUpdater downloads from files[] after arch
  // filtering, so point them at the first entry for backward-compat.
  return (
    `version: ${version}\n` +
    `files:\n${filesYaml}\n` +
    `path: ${ordered[0].url}\n` +
    `sha512: ${ordered[0].sha512}\n` +
    `releaseDate: ${JSON.stringify(releaseDate ?? new Date().toISOString())}\n`
  )
}

// The release gate. Everything it asserts is observable in the published artifact: a zip entry per
// arch (that is the entry electron-updater's MacUpdater downloads), each carrying a real sha512 and
// a positive size, and — when the zip is on disk — agreeing with that zip's actual bytes.
export const inspectMacFeed = async (text, dir) => {
  const problems = []
  const feed = parseMacFeed(text)
  if (!feed.version) problems.push('the feed has no `version:` field')
  const entries = {}
  for (const arch of MAC_ARCHES) {
    const matches = feed.entries.filter(
      (entry) => ARCH_ZIP[arch].test(String(entry.url ?? '')) && String(entry.url).includes(arch)
    )
    if (matches.length === 0) {
      problems.push(
        `no -mac-${arch}.zip entry (an installed ${arch} app cannot update from this feed)`
      )
      continue
    }
    if (matches.length > 1) {
      problems.push(
        `${matches.length} -mac-${arch}.zip entries (${matches.map((m) => m.url).join(', ')})`
      )
      continue
    }
    const [entry] = matches
    entries[arch] = entry
    if (!SHA512_BASE64.test(String(entry.sha512 ?? ''))) {
      problems.push(`${arch}: entry ${entry.url} has no valid sha512`)
    }
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
      problems.push(`${arch}: entry ${entry.url} has no valid size`)
    }
  }

  if (dir) {
    const names = readdirSync(dir)
    for (const arch of MAC_ARCHES) {
      const zip = names.find((name) => ARCH_ZIP[arch].test(name))
      const entry = entries[arch]
      if (!zip || !entry) continue
      const { size } = statSync(join(dir, zip))
      const sha512 = await sha512Base64(join(dir, zip))
      if (entry.sha512 !== sha512)
        problems.push(`${arch}: feed sha512 does not match ${zip} on disk`)
      if (entry.size !== size)
        problems.push(`${arch}: feed size ${entry.size} != ${zip} (${size} bytes)`)
    }
  }

  return { version: feed.version, entries, problems }
}

const reportProblems = (error, heading, problems) => {
  error(`::error::${heading}`)
  for (const problem of problems) error(`::error::  ${problem}`)
  error(
    '::error::Apple Silicon apps poll latest-mac.yml and take the entry whose url carries `arm64`; a ' +
      'feed without it makes them install the x64 build or fail the check entirely.'
  )
}

export const runMergeMacFeedCli = async (
  argv = process.argv.slice(2),
  {
    log = console.log,
    error = console.error,
    write = process.stdout.write.bind(process.stdout)
  } = {}
) => {
  const flags = argv.filter((argument) => argument.startsWith('--'))
  const dir = argv.find((argument) => !argument.startsWith('--')) ?? '.'
  const feedPath = join(dir, MAC_FEED_FILE)

  if (!existsSync(dir)) {
    // A named failure: the artifact dir comes from a download step, so its absence is a pipeline
    // wiring fault, not something the merge can paper over.
    error(`::error::mac artifact directory ${dir} does not exist`)
    return 1
  }

  if (flags.includes('--verify')) {
    if (!existsSync(feedPath)) {
      error(`::error::mac update feed ${feedPath} is missing`)
      return 1
    }
    const { entries, problems, version } = await inspectMacFeed(readFileSync(feedPath, 'utf8'), dir)
    if (problems.length > 0) {
      reportProblems(
        error,
        `mac update feed ${feedPath} is not complete for both architectures:`,
        problems
      )
      return 1
    }
    // Name the artifacts the gate just cleared: the release log is the only place the per-arch
    // url + digest the updater will verify is visible before the Release exists.
    for (const arch of MAC_ARCHES) {
      log(`merge-mac-feed: ${arch} -> ${entries[arch].url} (${entries[arch].size} bytes)`)
    }
    log(`merge-mac-feed: ${feedPath} advertises both architectures for ${version}`)
    return 0
  }

  const { version, releaseDate, entries, problems } = await resolveMacFeedInputs(dir)
  if (problems.length > 0) {
    const missingArches = MAC_ARCHES.filter((arch) => !entries[arch])
    if (flags.includes('--allow-missing') && missingArches.length === MAC_ARCHES.length) {
      log(`merge-mac-feed: no mac artifacts in ${dir}, nothing to merge`)
      return 0
    }
    reportProblems(error, `refusing to write ${feedPath} without both architectures:`, problems)
    return 1
  }

  const text = buildMacFeedText({ version, entries, releaseDate })
  writeFileSync(feedPath, text)
  for (const arch of MAC_ARCHES) log(`merge-mac-feed: ${arch} from ${entries[arch].source}`)
  write(text)
  return 0
}

// Top-level await is available in the ESM module form this repo runs scripts in (node 22).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runMergeMacFeedCli()
}
