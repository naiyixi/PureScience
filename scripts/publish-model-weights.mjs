#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Publishes one revision of the local-parsing-model weights as release assets we host ourselves, and
// writes the manifest that ships inside the app.
//
//   npm run publish:model-weights -- --spec <spec.json>                      offline: build + print
//   npm run publish:model-weights -- --spec <spec.json> --out <manifest.json>
//   npm run publish:model-weights -- --spec <spec.json> --out <manifest.json> --upload
//   npm run publish:model-weights -- --verify <manifest.json> [--dir <dir>]  gate: check files
//
// (Directly: `node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON scripts/publish-model-weights.mjs …`.
// The flag only silences Node's note about importing this repo's TypeScript without a "type" field.)
//
// The spec is the human-edited half; the manifest is the machine-readable half the app reads offline
// (see src/main/engines/model-weight-manifest-file.ts for the three states the reader can be in):
//
//   {
//     "releaseBase": "https://github.com/<owner>/<repo>/releases/download/<tag>",
//     "manifestRevision": "2026-10-16.1",
//     "publisher": "PureScience",
//     "entries": [
//       { "id": "doc-parse-primary", "revision": "abc123", "kind": "document-parse",
//         "license": "Apache-2.0", "file": "weights/doc-parse.onnx",
//         "assetName": "doc-parse.onnx", "publisherMd5": "…", "note": "…" }
//     ]
//   }
//
// Two rules this script exists to keep, both about who is allowed to state a digest:
//
//   * the sha256 is computed HERE, over the exact bytes we are about to host. We redistribute the
//     weights, so we are the publisher; a publisher that ships a digest it did not compute itself is
//     certifying nothing. An author-published md5, where one exists, rides along as `publisherMd5` —
//     an extra cross-check, never a substitute.
//   * nothing is written until what we host is what we read back: in upload mode every asset is
//     re-downloaded and re-hashed after the upload, and the manifest is written only if all of them
//     still match. The offline path opens no socket at all.
//
// The shape rules are deliberately NOT re-implemented here. They are imported from
// src/main/engines/model-weight-manifest.ts — the same module the app reads the shipped manifest with —
// so the publisher and the reader cannot drift into two opinions about what a valid manifest is.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateModelWeightManifest } from '../src/main/engines/model-weight-manifest.ts'

// One field drives both halves of "where this lives": the URL we write into each entry and the release
// the uploader talks to. Splitting them into two flags is how they end up disagreeing.
const RELEASE_BASE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)$/

/** A refusal is a named, expected outcome — not a crash. Tests assert on `reason`. */
class Refusal extends Error {
  constructor(reason, message) {
    super(message)
    this.name = 'Refusal'
    this.reason = reason
  }
}

const refuse = (reason, message) => {
  throw new Refusal(reason, message)
}

/** sha256 + exact byte length of a file, streamed so a multi-hundred-MB weight never lands in memory. */
const sha256OfFile = async (path) => {
  const hash = createHash('sha256')
  let bytes = 0
  await new Promise((onEnd, onError) => {
    createReadStream(path)
      .on('data', (chunk) => {
        bytes += chunk.length
        hash.update(chunk)
      })
      .on('end', onEnd)
      .on('error', onError)
  })
  return { sha256: hash.digest('hex'), bytes }
}

/**
 * What to actually hand to the uploader for one entry, and how to undo the staging.
 *
 * Two rules meet here. gh names the asset after the file it is given, so when the manifest's asset name
 * differs from the local file's name the bytes must be uploaded from a copy named as promised — a copy, not
 * a rename, because the author's file is theirs. And the copy is reported together with its cleanup so the
 * caller cannot forget it: a staged 300 MB weight left behind is a silent cost on the machine that
 * published.
 */
export const prepareUpload = ({ file, name, stage }) => {
  if (basename(file) === name) {
    // The common case: the file already carries the name the manifest publishes.
    return { path: file, cleanup: () => {} }
  }
  const stagedDirectory = (stage ?? defaultStage)({ file, name })
  return {
    path: join(stagedDirectory, name),
    cleanup: () => rmSync(stagedDirectory, { recursive: true, force: true })
  }
}

const defaultStage = ({ file, name }) => {
  const directory = mkdtempSync(join(tmpdir(), 'ps-model-weights-upload-'))
  copyFileSync(file, join(directory, name))
  return directory
}

/**
 * Builds the uploader for one entry. `run` is the process call, injected so the parts that are easy to get
 * wrong here — which path is handed to gh, and whether the staged copy is always removed — can be tested
 * against the real implementation instead of a re-implementation.
 */
export const createUploadAsset =
  ({ run = (args) => execFileSync('gh', args, { stdio: 'inherit' }), stage } = {}) =>
  async ({ repo, tag, file, name, clobber }) => {
    const prepared = prepareUpload({ file, name: name ?? basename(file), stage })
    try {
      const args = ['release', 'upload', tag, prepared.path, '--repo', repo]
      if (clobber) args.push('--clobber')
      run(args)
    } finally {
      // Always: a staged copy that survives a failed upload is 300 MB of litter nobody will look for.
      prepared.cleanup()
    }
  }

const realDeps = {
  sha256OfFile,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  /**
   * Uploads one local file as a release asset named `name`. Refuses to overwrite unless `clobber` is set.
   *
   * `gh release upload` names an asset after the file it is handed (the `#` suffix is only a display
   * label, not the name the URL uses), so a file whose own name differs from the manifest's is uploaded
   * from a staged copy named exactly as the manifest promises — otherwise we would publish a URL for a
   * name that no upload ever created, and the read-back below would be the first thing to notice.
   */
  uploadAsset: createUploadAsset(),
  /** Returns exactly the bytes a reader would fetch from `url`. */
  fetchAsset: async (url) => {
    const response = await fetch(url)
    if (!response.ok) refuse('fetch-failed', `GET ${url} -> ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
}

const parseSpec = (specPath, deps) => {
  let parsed
  try {
    parsed = JSON.parse(deps.readFileSync(specPath, 'utf8'))
  } catch (error) {
    refuse('spec-unreadable', `cannot read the spec at ${specPath}: ${error.message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    refuse('spec-invalid', 'the spec must be a JSON object')
  }
  return parsed
}

/**
 * Turns a spec plus the local files it points at into (a) the manifest we will ship and (b) the upload
 * plan. Every failure here is named and happens before anything is uploaded or written.
 */
const buildManifest = async ({ specPath, deps = realDeps, baseDir }) => {
  const spec = parseSpec(specPath, deps)

  const match = typeof spec.releaseBase === 'string' ? RELEASE_BASE.exec(spec.releaseBase) : null
  if (!match) {
    refuse(
      'release-base-invalid',
      'releaseBase must look like https://github.com/<owner>/<repo>/releases/download/<tag> — it is ' +
        'the single source for both the URLs we publish and the release we upload to'
    )
  }
  const [, owner, repo, tag] = match

  if (typeof spec.manifestRevision !== 'string' || spec.manifestRevision.trim() === '') {
    refuse('manifest-revision-missing', 'manifestRevision must be a non-empty string')
  }
  if (typeof spec.publisher !== 'string' || spec.publisher.trim() === '') {
    // Empty would mean "published by nobody", which is the one answer a reader cannot act on.
    refuse(
      'publisher-missing',
      'publisher must be a non-empty string — it is who is answerable for these bytes'
    )
  }
  if (!Array.isArray(spec.entries) || spec.entries.length === 0) {
    refuse(
      'entries-empty',
      'entries must be a non-empty array; a publish run with nothing to publish is a mistake'
    )
  }

  const dir = baseDir ?? dirname(resolve(specPath))
  const seenAssetNames = new Map()
  const assets = []
  const entries = []

  for (const [index, raw] of spec.entries.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      refuse('entry-invalid', `entries[${index}] must be an object`)
    }
    if (typeof raw.file !== 'string' || raw.file.trim() === '') {
      refuse('entry-invalid', `entries[${index}].file must be a non-empty path`)
    }
    const file = resolve(dir, raw.file)
    if (!deps.existsSync(file) || !deps.statSync(file).isFile()) {
      refuse('entry-file-missing', `entries[${index}].file is not a file on disk: ${file}`)
    }

    const assetName =
      typeof raw.assetName === 'string' && raw.assetName.trim() !== ''
        ? raw.assetName
        : basename(file)
    if (assetName.includes('/') || assetName.includes('\\')) {
      refuse(
        'asset-name-invalid',
        `entries[${index}].assetName must be a bare file name, got "${assetName}"`
      )
    }
    const firstUse = seenAssetNames.get(assetName)
    if (firstUse !== undefined) {
      // Two entries sharing one asset name would mean two identities pointing at the same bytes.
      refuse(
        'asset-name-duplicated',
        `assetName "${assetName}" is used by entries[${firstUse}] and entries[${index}]`
      )
    }
    seenAssetNames.set(assetName, index)

    let digest
    try {
      digest = await deps.sha256OfFile(file)
    } catch (error) {
      refuse('entry-file-unreadable', `cannot read ${file}: ${error.message}`)
    }
    if (digest.bytes <= 0) {
      // A zero-byte weight is not a weight; publishing it would hand readers a digest for nothing.
      refuse('entry-file-empty', `${file} is empty; refusing to publish zero bytes`)
    }

    assets.push({ index, file, assetName, sha256: digest.sha256, bytes: digest.bytes })
    entries.push({
      id: raw.id,
      revision: raw.revision,
      publisher: spec.publisher,
      url: `${spec.releaseBase}/${assetName}`,
      sha256: digest.sha256,
      bytes: digest.bytes,
      license: raw.license,
      kind: raw.kind,
      ...(raw.publisherMd5 === undefined ? {} : { publisherMd5: raw.publisherMd5 }),
      ...(raw.note === undefined ? {} : { note: raw.note })
    })
  }

  const manifest = { schema: 1, revision: spec.manifestRevision, entries }

  // The publisher's own output goes through the reader's rules. Anything the reader would reject must
  // fail here instead of shipping as a manifest that can never validate.
  const problems = validateModelWeightManifest(manifest)
  if (problems.length > 0) {
    const lines = problems.map(
      (problem) => `  entries[${problem.index}].${problem.field}: ${problem.message}`
    )
    refuse('manifest-invalid', `the generated manifest does not validate:\n${lines.join('\n')}`)
  }

  return { manifest, assets, repo: `${owner}/${repo}`, tag }
}

/** Basename of an entry's URL: that is the name the asset must have in `dir`. */
const assetNameFromUrl = (url) => basename(new URL(url).pathname)

/**
 * Checks local files against a shipped manifest: the reader's validation first (a manifest we cannot
 * trust produces no asset verdicts at all — "not checked" must never read as a pass), then a real
 * re-hash and re-measure of every asset. Returns every problem; an empty list is the only pass.
 */
const verifyManifestAgainstDirectory = async ({ manifest, dir, deps = realDeps }) => {
  const problems = validateModelWeightManifest(manifest).map((problem) => ({
    asset: problem.index < 0 ? '<manifest>' : assetNameFromUrl(manifest.entries[problem.index].url),
    field: problem.field,
    message: problem.message
  }))
  if (problems.length > 0) return problems

  for (const entry of manifest.entries) {
    const name = assetNameFromUrl(entry.url)
    const file = join(dir, name)
    if (!deps.existsSync(file) || !deps.statSync(file).isFile()) {
      problems.push({ asset: name, field: 'file', message: `missing from ${dir}` })
      continue
    }
    let digest
    try {
      digest = await deps.sha256OfFile(file)
    } catch (error) {
      problems.push({ asset: name, field: 'file', message: `unreadable: ${error.message}` })
      continue
    }
    if (digest.bytes !== entry.bytes) {
      problems.push({
        asset: name,
        field: 'bytes',
        message: `expected ${entry.bytes}, measured ${digest.bytes}`
      })
    }
    if (digest.sha256 !== entry.sha256) {
      problems.push({
        asset: name,
        field: 'sha256',
        message: `expected ${entry.sha256}, measured ${digest.sha256}`
      })
    }
  }

  return problems
}

/**
 * The whole publish flow. Offline by default: with `upload: false` no uploader or fetcher is ever
 * called. With `upload: true` every asset is uploaded, then fetched back from its published URL and
 * re-hashed, and the manifest is written only if all of them still match what we sent.
 */
const publish = async ({
  specPath,
  outPath,
  upload = false,
  clobber = false,
  deps = realDeps,
  baseDir
}) => {
  const { manifest, assets, repo, tag } = await buildManifest({ specPath, deps, baseDir })
  const text = `${JSON.stringify(manifest, null, 2)}\n`

  if (!upload) {
    if (outPath) {
      deps.writeFileSync(outPath, text)
      return { manifest, wrote: outPath, uploaded: 0, verified: 0 }
    }
    return { manifest, wrote: null, uploaded: 0, verified: 0 }
  }

  if (!outPath) {
    refuse(
      'out-missing',
      'upload mode needs --out: refusing to publish without knowing where the manifest lands'
    )
  }

  for (const asset of assets) {
    // The name travels with the file: the URL we publish says `assetName`, so the upload has to create an
    // asset by that name rather than by whatever the local file happens to be called.
    await deps.uploadAsset({ repo, tag, file: asset.file, name: asset.assetName, clobber })
  }

  // Read back what the world will actually fetch. A digest computed before the upload says nothing
  // about what the release asset serves afterwards.
  const mismatches = []
  for (const entry of manifest.entries) {
    let bytes
    try {
      bytes = await deps.fetchAsset(entry.url)
    } catch (error) {
      mismatches.push(`  ${assetNameFromUrl(entry.url)}: fetch failed: ${error.message}`)
      continue
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== entry.sha256 || bytes.length !== entry.bytes) {
      mismatches.push(
        `  ${assetNameFromUrl(entry.url)}: published bytes are sha256 ${actual} / ${bytes.length} B, ` +
          `manifest says ${entry.sha256} / ${entry.bytes} B`
      )
    }
  }
  if (mismatches.length > 0) {
    refuse(
      'published-bytes-mismatch',
      `the release does not serve what we digested:\n${mismatches.join('\n')}`
    )
  }

  deps.writeFileSync(outPath, text)
  return { manifest, wrote: outPath, uploaded: assets.length, verified: manifest.entries.length }
}

const USAGE = `usage:
  node scripts/publish-model-weights.mjs --spec <spec.json> [--out <manifest.json>]
  node scripts/publish-model-weights.mjs --spec <spec.json> --out <manifest.json> --upload [--clobber]
  node scripts/publish-model-weights.mjs --verify <manifest.json> [--dir <dir>]`

const readFlag = (argv, name) => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

const main = async (argv = process.argv.slice(2)) => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(USAGE)
    return 0
  }

  const verifyPath = readFlag(argv, '--verify')
  if (verifyPath) {
    const dir = readFlag(argv, '--dir') ?? dirname(resolve(verifyPath))
    const manifest = JSON.parse(realDeps.readFileSync(verifyPath, 'utf8'))
    const problems = await verifyManifestAgainstDirectory({ manifest, dir })
    for (const problem of problems) {
      console.error(`[publish-model-weights] ${problem.asset} ${problem.field}: ${problem.message}`)
    }
    const count = Array.isArray(manifest.entries) ? manifest.entries.length : 0
    if (problems.length > 0) {
      console.error(
        `[publish-model-weights] verify FAILED — ${problems.length} problem(s) across ${count} entr(y|ies)`
      )
      return 1
    }
    console.log(`[publish-model-weights] verify OK — ${count} entr(y|ies) re-hashed from ${dir}`)
    return 0
  }

  const specPath = readFlag(argv, '--spec')
  if (!specPath) {
    console.error(USAGE)
    return 1
  }
  const upload = argv.includes('--upload')
  const result = await publish({
    specPath,
    outPath: readFlag(argv, '--out'),
    upload,
    clobber: argv.includes('--clobber')
  })

  if (result.wrote) {
    console.log(
      `[publish-model-weights] ${upload ? 'uploaded and verified' : 'wrote'} ${result.wrote} — ` +
        `${result.manifest.entries.length} entries` +
        (upload
          ? ` (${result.uploaded} asset(s) uploaded, all re-hashed from their published URLs)`
          : '')
    )
  } else {
    console.log(JSON.stringify(result.manifest, null, 2))
  }
  return 0
}

export {
  buildManifest,
  createUploadAsset,
  main,
  prepareUpload,
  publish,
  realDeps,
  sha256OfFile,
  verifyManifestAgainstDirectory,
  Refusal
}

// Run as a CLI only when invoked directly (importing for tests must not publish anything).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof Refusal) {
        console.error(`[publish-model-weights] refused (${error.reason}): ${error.message}`)
        process.exit(1)
      }
      console.error('[publish-model-weights] failed:', error)
      process.exit(1)
    })
}
