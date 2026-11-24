#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

import { VERSIONS, packArchiveFile, packId, readDefaultEnvVersion } from './stage-default-envs.mjs'

export const DEFAULT_CDN_BASE =
  'https://github.com/naiyixi/PureScience/releases/download/runtime-v1'

// GitHub Releases serve flat asset names; any other base keeps the hierarchical object-store layout.
const isFlatReleaseAssetBase = (base) => /\/releases\/download\/[^/]+\/?$/.test(base)

export const runtimeManifestUrl = (cdnBase, envVersion, subdir) => {
  const base = cdnBase.replace(/\/+$/, '')
  return isFlatReleaseAssetBase(base)
    ? `${base}/${subdir}-manifest.json`
    : `${base}/runtime-bundle/${envVersion}/${subdir}/manifest.json`
}

// Same composition as the runtime client's packUrl (src/main/notebook/bundle-manifest.ts); the paired
// case in verify-runtime-bundle.test.ts asserts the two agree, so this cannot drift into fetching from a
// key the app would never ask for.
export const runtimePackUrl = (cdnBase, envVersion, subdir, file) => {
  const base = cdnBase.replace(/\/+$/, '')
  return isFlatReleaseAssetBase(base)
    ? `${base}/${subdir}-${file}`
    : `${base}/runtime-bundle/${envVersion}/${subdir}/${file}`
}

export const validatePublishedManifest = (manifest, envVersion, subdir) => {
  if (!manifest || manifest.schema !== 1) throw new Error('manifest schema must be 1')
  if (manifest.envVersion !== envVersion) {
    throw new Error(`manifest envVersion ${manifest.envVersion} does not match ${envVersion}`)
  }
  if (manifest.subdir !== subdir) {
    throw new Error(`manifest subdir ${manifest.subdir} does not match ${subdir}`)
  }
  for (const [language, versions] of Object.entries(VERSIONS)) {
    for (const version of versions) {
      const id = packId(language, version)
      const entry = manifest.packs?.[id]
      if (!entry) throw new Error(`manifest is missing ${id}`)
      if (
        entry.language !== language ||
        entry.version !== version ||
        entry.file !== packArchiveFile(language, version)
      ) {
        throw new Error(`manifest has an invalid canonical entry for ${id}`)
      }
      if (
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isInteger(entry.size) ||
        entry.size <= 0
      ) {
        throw new Error(`manifest has invalid integrity metadata for ${id}`)
      }
    }
  }
}

export const verifyRuntimeBundle = async (cdnBase, envVersion, subdirs, fetchImpl = fetch) => {
  for (const subdir of subdirs) {
    const url = runtimeManifestUrl(cdnBase, envVersion, subdir)
    const response = await fetchImpl(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
    const manifest = await response.json()
    validatePublishedManifest(manifest, envVersion, subdir)
    console.log(`[runtime-bundle] verified ${url}`)
  }
}

const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })

export const packCachePath = (cacheDir, subdir, envVersion, file) =>
  join(cacheDir, subdir, String(envVersion), file)

const downloadToFile = async (url, destPath, fetchImpl) => {
  const response = await fetchImpl(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  if (!response.body) throw new Error(`${url} answered without a body`)
  await mkdir(dirname(destPath), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath))
}

// Pre-fetches the curated pack archives into the machine cache the runtime client reads
// (PURESCIENCE_RUNTIME_PACK_CACHE), so a lane that starts many apps pays for the transfer once instead of
// once per spec.
//
// Why this exists: the Windows P0 lane transferred the same ~100 MB pack per spec, and on 2026-11-23 one
// slow transfer consumed a spec's whole 600 s budget — the failure surfaced as a notebook timeout rather
// than as a download problem (see
// docs/evidence/2026-11-24-windows-gate-second-reading-and-the-transfer-that-cost-it.md). Moving the
// transfer into a step with its own budget turns that class of red into one named line.
//
// It deliberately does not weaken any check: the manifest is fetched from the network here and by the app
// on every provisioning attempt, and the digest in it is what decides whether a cached archive is used.
export const prewarmRuntimePack = async ({
  cacheDir,
  cdnBase = DEFAULT_CDN_BASE,
  envVersion = readDefaultEnvVersion(),
  subdir,
  languages = ['python'],
  fetchImpl = fetch,
  sha256 = sha256File,
  log = (line) => console.log(line),
  maxAttempts = 3
}) => {
  if (!cacheDir) throw new Error('prewarmRuntimePack needs a cacheDir')
  if (!subdir) throw new Error('prewarmRuntimePack needs a subdir (e.g. win-64)')
  const manifestResponse = await fetchImpl(runtimeManifestUrl(cdnBase, envVersion, subdir), {
    cache: 'no-store'
  })
  if (!manifestResponse.ok) {
    throw new Error(
      `${runtimeManifestUrl(cdnBase, envVersion, subdir)} returned HTTP ${manifestResponse.status}`
    )
  }
  const manifest = await manifestResponse.json()
  validatePublishedManifest(manifest, envVersion, subdir)

  const wanted = languages.flatMap((language) =>
    (VERSIONS[language] ?? []).map((version) => packId(language, version))
  )
  const results = []
  for (const id of wanted) {
    const entry = manifest.packs[id]
    const dest = packCachePath(cacheDir, subdir, envVersion, entry.file)
    const present = await stat(dest).catch(() => undefined)
    if (present?.isFile() && present.size === entry.size && (await sha256(dest)) === entry.sha256) {
      log(`prewarm: have ${entry.file} (${entry.size} bytes, sha256 ok)`)
      results.push({ file: entry.file, action: 'have' })
      continue
    }
    const url = runtimePackUrl(cdnBase, envVersion, subdir, entry.file)
    let lastError
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const staging = `${dest}.part`
      try {
        await rm(staging, { force: true })
        await downloadToFile(url, staging, fetchImpl)
        const digest = await sha256(staging)
        if (digest !== entry.sha256) {
          throw new Error(`sha256 mismatch for ${entry.file} (got ${digest})`)
        }
        await rename(staging, dest)
        log(`prewarm: fetched ${entry.file} (${entry.size} bytes, sha256 ok)`)
        results.push({ file: entry.file, action: 'fetched' })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        await rm(staging, { force: true }).catch(() => undefined)
        log(
          `prewarm: attempt ${attempt}/${maxAttempts} failed for ${entry.file}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
    // Not retried and not silently skipped: an archive the lane cannot obtain is the one fact the caller
    // must see, and continuing would only turn it into a per-spec timeout later.
    if (lastError) throw new Error(`could not prewarm ${entry.file}: ${lastError.message}`)
  }
  return results
}

const main = async () => {
  const subdirs = process.argv.slice(2)
  if (subdirs.length === 0) {
    throw new Error('usage: node scripts/verify-runtime-bundle.mjs <subdir> [subdir...]')
  }
  await verifyRuntimeBundle(
    process.env.PURESCIENCE_ENV_CDN_BASE || DEFAULT_CDN_BASE,
    readDefaultEnvVersion(),
    subdirs
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[runtime-bundle] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
