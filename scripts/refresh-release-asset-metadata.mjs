/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Refreshes the two release-page files that describe installer BYTES — `version.json` and
// `RELEASE-CERTIFICATION.json` — after a post-publication repair replaced those bytes.
//
// Why this exists: `notarize-mac.yml`'s standalone path (workflow_dispatch with a tag) re-emits the
// mac dmg/zip with a stapled ticket and clobbers them onto an existing Release. Stapling changes the
// bytes, so it refreshes `SHA256SUMS.txt` and `latest-mac.yml` — but `version.json` (the manifest the
// in-app update flow polls) and the certification record kept the pre-staple digests. A page in that
// state advertises a sha256 for a file nobody can download: a manifest client checking the digest of
// the stapled dmg rejects it, and the record's own artifact digests disagree with SHA256SUMS.txt,
// which is exactly the disagreement `scripts/verify-release.mjs` refuses to certify. The full release
// path (build -> notarize -> publish) never had the problem: publish aggregates after stapling.
//
// House rules this file follows:
//   - the installer names come from `generate-version-manifest.mjs` (one source of truth), never
//     re-spelled here;
//   - a file the record names but the directory does not carry is a NAMED failure, never a silent
//     "keep the old digest" — keeping the stale digest is the defect this script exists to fix;
//   - only the digest/size fields are rewritten. Notes, release dates, signing state and check
//     results were measured when they were measured; re-deriving them here would be inventing
//     evidence, not refreshing it.
//
// Usage:
//   node scripts/refresh-release-asset-metadata.mjs <assets-dir> <tag>
//     [--repo owner/name] [--now <ISO timestamp>]
//
// Exit 0 only when both files were rewritten (or already correct) and every digest lists a real file.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  INSTALLERS,
  VERSION_PATTERN,
  manifestNotes,
  parseSha256Sums
} from './generate-version-manifest.mjs'

const DEFAULT_REPO = 'naiyixi/PureScience'
const MANIFEST_FILE = 'version.json'
const CERTIFICATION_FILE = 'RELEASE-CERTIFICATION.json'
const SUMS_FILE = 'SHA256SUMS.txt'

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const versionFromTag = (tag) => {
  const text = String(tag ?? '').trim()
  const candidate = text.replace(/^v(?=\d)/, '')
  if (!VERSION_PATTERN.test(candidate)) {
    throw new Error(
      `not a release tag: ${JSON.stringify(text)} (expected v<major>.<minor>.<patch>)`
    )
  }
  return candidate
}

// The URL family of an already-published manifest entry, so a refreshed entry keeps pointing at the
// same host/prefix. Falls back to the GitHub asset layout the publish job writes.
const assetUrl = (existingUrl, { repo, tag, file }) => {
  if (typeof existingUrl === 'string' && existingUrl.trim()) {
    const slash = existingUrl.lastIndexOf('/')
    if (slash > 0) return `${existingUrl.slice(0, slash)}/${file}`
  }
  return `https://github.com/${repo}/releases/download/${tag}/${file}`
}

export const refreshVersionManifest = ({ directory, tag, repo = DEFAULT_REPO }) => {
  const version = versionFromTag(tag)
  const releaseTag = `v${version}`
  const sumsPath = join(directory, SUMS_FILE)
  if (!existsSync(sumsPath)) {
    throw new Error(
      `${SUMS_FILE} is not in ${directory}; refresh the checksums before the manifest`
    )
  }
  const sums = parseSha256Sums(readFileSync(sumsPath, 'utf8'))
  if (Object.keys(sums).length === 0) {
    throw new Error(
      `${SUMS_FILE} in ${directory} lists no digests; refusing to rewrite a manifest from it`
    )
  }

  const manifestPath = join(directory, MANIFEST_FILE)
  const existing = existsSync(manifestPath) ? readJson(manifestPath) : undefined
  if (existing && existing.version && String(existing.version) !== version) {
    throw new Error(
      `existing ${MANIFEST_FILE} describes version ${existing.version}, not ${version}; ` +
        'refusing to rewrite a manifest under a different release'
    )
  }

  const downloads = {}
  const changed = []
  const added = []
  const absent = []
  const missingDigest = []
  // The union of what the published manifest describes and what this channel knows how to name. An
  // entry the manifest already carries is checked too: keeping its old digest while the file is gone
  // (or unverifiable) is the same defect as never refreshing it.
  const keys = Object.keys(existing?.downloads ?? {})
  for (const key of Object.keys(INSTALLERS)) {
    if (!keys.includes(key)) keys.push(key)
  }
  for (const key of keys) {
    const previous = existing?.downloads?.[key]
    const file =
      INSTALLERS[key]?.(version) ??
      (previous?.url ? String(previous.url).split('/').pop() : undefined)
    if (!file) continue
    const filePath = join(directory, file)
    if (!existsSync(filePath)) {
      if (previous) absent.push(`${key}:${file}`)
      continue
    }
    const digest = sums[file]
    if (!digest) {
      missingDigest.push(file)
      continue
    }
    const entry = {
      url: assetUrl(previous?.url, { repo, tag: releaseTag, file }),
      size: statSync(filePath).size,
      sha256: digest
    }
    if (!previous) added.push(key)
    else if (previous.sha256 !== entry.sha256 || previous.size !== entry.size) changed.push(key)
    downloads[key] = entry
  }
  if (absent.length > 0) {
    throw new Error(
      `the manifest names installer(s) this release does not carry: ${absent.join(', ')}; ` +
        'a digest for a file nobody can download is not a refresh'
    )
  }
  if (missingDigest.length > 0) {
    throw new Error(
      `installer(s) present without a ${SUMS_FILE} entry: ${missingDigest.join(', ')}; ` +
        'the checksum list and the directory disagree'
    )
  }
  if (Object.keys(downloads).length === 0) {
    throw new Error(
      `no installers found in ${directory}; refusing to write an empty ${MANIFEST_FILE}`
    )
  }

  // `notes` is what the in-app update dialog shows and `releaseDate` is when the release was cut.
  // Neither is a property of the installer bytes, so they are carried over, not recomputed.
  const manifest = {
    version,
    notes: existing?.notes ?? manifestNotes(version),
    releaseDate: existing?.releaseDate ?? new Date().toISOString(),
    downloads
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { path: manifestPath, version, changed, added, total: Object.keys(downloads).length }
}

export const refreshCertificationDigests = ({ directory }) => {
  const certPath = join(directory, CERTIFICATION_FILE)
  if (!existsSync(certPath)) {
    throw new Error(
      `${CERTIFICATION_FILE} is not in ${directory}; the release page has no record to refresh`
    )
  }
  const record = readJson(certPath)
  const platforms = Array.isArray(record?.platforms) ? record.platforms : []
  const macPlatforms = platforms.filter(
    (platform) => typeof platform?.platform === 'string' && platform.platform.startsWith('macos-')
  )
  if (macPlatforms.length === 0) {
    throw new Error(
      `${CERTIFICATION_FILE} carries no macos-* platform; nothing a mac repair could refresh`
    )
  }
  const absent = []
  const changed = []
  for (const platform of macPlatforms) {
    const artifacts = Array.isArray(platform.artifacts) ? platform.artifacts : []
    if (artifacts.length === 0) {
      throw new Error(`certification record for ${platform.platform} lists no artifacts`)
    }
    for (const artifact of artifacts) {
      const artifactPath = join(directory, String(artifact?.name ?? ''))
      if (!artifact?.name || !existsSync(artifactPath)) {
        absent.push(`${platform.platform}:${artifact?.name ?? '(unnamed)'}`)
        continue
      }
      const digest = sha256(artifactPath)
      if (artifact.sha256 !== digest) {
        changed.push(`${platform.platform}:${artifact.name}`)
        artifact.sha256 = digest
      }
    }
  }
  if (absent.length > 0) {
    throw new Error(
      `certification record names artifact(s) absent from ${directory}: ${absent.join(', ')}; ` +
        'refusing to leave a digest that describes bytes nobody can download'
    )
  }
  if (changed.length > 0) {
    // Read by humans and by the next repair round: the digests in this record were recomputed after
    // the published bytes were replaced, not when the build certified them.
    record.metadataRefreshed = {
      reason: 'stapled-assets-replaced-after-publication',
      digests: changed,
      at: new Date().toISOString()
    }
    writeFileSync(certPath, `${JSON.stringify(record, null, 2)}\n`)
  }
  return {
    path: certPath,
    changed,
    macPlatforms: macPlatforms.map((platform) => platform.platform)
  }
}

const main = () => {
  const argv = process.argv.slice(2)
  const positionals = []
  let repo = DEFAULT_REPO
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--repo') {
      repo = argv[index + 1]
      if (!repo) throw new Error('--repo needs a value')
      index += 1
    } else if (argv[index].startsWith('--')) {
      throw new Error(`unexpected flag ${argv[index]}`)
    } else {
      positionals.push(argv[index])
    }
  }
  const [directory, tag] = positionals
  if (!directory || !tag) {
    throw new Error(
      'usage: refresh-release-asset-metadata.mjs <assets-dir> <tag> [--repo owner/name]'
    )
  }
  const manifest = refreshVersionManifest({ directory, tag, repo })
  const certification = refreshCertificationDigests({ directory })
  console.log(
    `==> ${MANIFEST_FILE}: version=${manifest.version} downloads=${manifest.total} ` +
      `refreshed=[${manifest.changed.join(', ')}] added=[${manifest.added.join(', ')}]`
  )
  console.log(
    `==> ${CERTIFICATION_FILE}: platforms=${certification.macPlatforms.join(',')} ` +
      `refreshed=${certification.changed.length}` +
      (certification.changed.length > 0 ? ` [${certification.changed.join(', ')}]` : '')
  )
}

if (process.argv[1]?.endsWith('refresh-release-asset-metadata.mjs')) {
  try {
    main()
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
