// Installing a case from the marketplace is three untrusting steps, in this order:
//
//   1. download the archive to a temp file while hashing it, and stop at the byte cap;
//   2. compare the digest with the one the index pinned — a mismatch never reaches the unpacker;
//   3. unpack into a staging directory, then hand it to the bundle reader, which re-verifies every file's digest
//      against the manifest. Only after that does anything land in the case library.
//
// The archive is transport; the bundle manifest is the contract. Unpacking a file whose digest we have not checked
// would be executing the publisher's naming before the publisher's promises.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

import * as tar from 'tar'

import {
  CASE_MARKETPLACE_INDEX_BYTES_LIMIT,
  type CaseMarketplaceEntry,
  type CaseMarketplaceIndex,
  validateCaseMarketplaceIndex
} from '../../shared/case-marketplace'
import type { CaseBundleImportProblem } from '../../shared/case-bundle'
import { importCaseBundle, materialiseCaseBundle } from './import-bundle'

/** A case archive is data, not an installer: past this it is doing something other than being a case. */
export const CASE_ARCHIVE_BYTES_LIMIT = 512 * 1024 * 1024
export const CASE_MARKETPLACE_TIMEOUT_MS = 20_000
/** A stall longer than this means the connection is gone, whatever the socket believes. */
export const CASE_ARCHIVE_IDLE_TIMEOUT_MS = 60_000
/** Hard ceiling on one archive, so a trickle cannot keep a job alive forever. */
export const CASE_ARCHIVE_TOTAL_TIMEOUT_MS = 15 * 60_000

export type CaseMarketplaceFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: 'follow' }
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
  json(): Promise<unknown>
}>

export type CaseMarketplaceFetchResult =
  | { ok: true; index: CaseMarketplaceIndex }
  | {
      ok: false
      problem: 'unreachable' | 'bad-response' | 'too-large' | 'bad-index'
      detail?: string
    }

const withTimeout = async <T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export const fetchCaseMarketplaceIndex = async (
  url: string,
  options: { fetchImpl?: CaseMarketplaceFetch; timeoutMs?: number } = {}
): Promise<CaseMarketplaceFetchResult> => {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as CaseMarketplaceFetch)
  let response
  try {
    response = await withTimeout(options.timeoutMs ?? CASE_MARKETPLACE_TIMEOUT_MS, (signal) =>
      fetchImpl(url, { signal, redirect: 'follow' })
    )
  } catch (error) {
    return { ok: false, problem: 'unreachable', detail: String(error) }
  }
  if (!response.ok) return { ok: false, problem: 'bad-response', detail: `HTTP ${response.status}` }

  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > CASE_MARKETPLACE_INDEX_BYTES_LIMIT) {
    return { ok: false, problem: 'too-large', detail: `${declared}` }
  }

  let text: string
  try {
    text = await withTimeout(options.timeoutMs ?? CASE_MARKETPLACE_TIMEOUT_MS, async () => {
      const body = response.body
      if (!body) throw new Error('empty body')
      let received = 0
      const chunks: Buffer[] = []
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength
        // A declared length can lie, so the running total is the one that decides.
        if (received > CASE_MARKETPLACE_INDEX_BYTES_LIMIT) throw new Error('too-large')
        chunks.push(Buffer.from(chunk))
      }
      return Buffer.concat(chunks).toString('utf8')
    })
  } catch (error) {
    const message = String(error)
    return message.includes('too-large')
      ? { ok: false, problem: 'too-large' }
      : { ok: false, problem: 'bad-response', detail: message }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'bad-index', detail: 'not-json' }
  }
  const validated = validateCaseMarketplaceIndex(parsed)
  if (!validated.ok) {
    return {
      ok: false,
      problem: 'bad-index',
      detail: `${validated.problem}${validated.detail ? `: ${validated.detail}` : ''}`
    }
  }
  return { ok: true, index: validated.index }
}

export type CaseArchiveDownload =
  | { ok: true; path: string; sha256: string; bytes: number }
  | { ok: false; problem: 'unreachable' | 'bad-response' | 'too-large'; detail?: string }

export const downloadCaseArchive = async (
  url: string,
  destinationFile: string,
  options: {
    fetchImpl?: CaseMarketplaceFetch
    maxBytes?: number
    idleTimeoutMs?: number
    totalTimeoutMs?: number
  } = {}
): Promise<CaseArchiveDownload> => {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as CaseMarketplaceFetch)
  const maxBytes = options.maxBytes ?? CASE_ARCHIVE_BYTES_LIMIT
  // Two clocks, because a slow link and a dead link look identical to a single deadline: an archive that keeps
  // arriving slowly is fine, an archive that stops arriving is not.
  const controller = new AbortController()
  const idleMs = options.idleTimeoutMs ?? CASE_ARCHIVE_IDLE_TIMEOUT_MS
  const totalMs = options.totalTimeoutMs ?? CASE_ARCHIVE_TOTAL_TIMEOUT_MS
  let rejectIdle: (error: Error) => void = () => undefined
  // The guard is a promise, not just an abort: a stream that never yields again cannot be interrupted from inside,
  // so the wait itself has to lose the race.
  const idleGuard = new Promise<never>((_resolve, reject) => {
    rejectIdle = reject
  })
  void idleGuard.catch(() => undefined)
  let idleTimer = setTimeout(() => rejectIdle(new Error('idle-timeout')), idleMs)
  const totalTimer = setTimeout(() => controller.abort(), totalMs)
  const keepAlive = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => rejectIdle(new Error('idle-timeout')), idleMs)
  }
  let response
  try {
    response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
  } catch (error) {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
    return { ok: false, problem: 'unreachable', detail: String(error) }
  }
  if (!response.ok) return { ok: false, problem: 'bad-response', detail: `HTTP ${response.status}` }
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, problem: 'too-large', detail: `${declared}` }
  }
  if (!response.body) return { ok: false, problem: 'bad-response', detail: 'empty body' }

  const hash = createHash('sha256')
  let bytes = 0
  keepAlive()
  await mkdir(dirname(destinationFile), { recursive: true })
  const sink = createWriteStream(destinationFile)
  try {
    const writing = pipeline(
      Readable.fromWeb(response.body as never),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          keepAlive()
          bytes += chunk.byteLength
          if (bytes > maxBytes) throw new Error('too-large')
          hash.update(chunk)
          yield chunk
        }
      },
      sink
    )
    await Promise.race([writing, idleGuard])
  } catch (error) {
    await sink.destroy()
    await rm(destinationFile, { force: true })
    const message = String(error)
    if (message.includes('too-large')) return { ok: false, problem: 'too-large' }
    if (message.includes('idle-timeout') || controller.signal.aborted) {
      return { ok: false, problem: 'unreachable', detail: 'timed-out' }
    }
    return { ok: false, problem: 'bad-response', detail: message }
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
  }
  return { ok: true, path: destinationFile, sha256: hash.digest('hex'), bytes }
}

const isSingleSegment = (name: string): boolean =>
  name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..'

export type CaseArchiveUnpack =
  | { ok: true; directory: string }
  | { ok: false; problem: 'unsafe-entry' | 'unpack-failed'; detail?: string }

// tar's own path handling already refuses absolute and traversal entries; this filter makes that refusal explicit
// and returns it as a name the caller can report, rather than as a crash deep inside the extractor.
export const unpackCaseArchive = async (
  archiveFile: string,
  targetDir: string
): Promise<CaseArchiveUnpack> => {
  await mkdir(targetDir, { recursive: true })
  let unsafe: string | null = null
  try {
    await tar.x({
      file: archiveFile,
      cwd: targetDir,
      strict: true,
      preservePaths: false,
      filter: (entryPath) => {
        const segments = entryPath.split('/').filter((segment) => segment.length > 0)
        // The archive holds one bundle directory: <name>/manifest.json and <name>/files/<file>.
        const ok = segments.length > 0 && segments.slice(1).every(isSingleSegment)
        if (!ok) unsafe = entryPath
        return ok
      }
    })
  } catch (error) {
    if (unsafe !== null) return { ok: false, problem: 'unsafe-entry', detail: unsafe }
    return { ok: false, problem: 'unpack-failed', detail: String(error) }
  }
  if (unsafe !== null) return { ok: false, problem: 'unsafe-entry', detail: unsafe }
  return { ok: true, directory: targetDir }
}

export type CaseInstallResult =
  | {
      ok: true
      name: string
      fileCount: number
      totalBytes: number
      bundleDir: string
      installedTo: string
    }
  | {
      ok: false
      problem:
        | 'unreachable'
        | 'bad-response'
        | 'too-large'
        | 'checksum-mismatch'
        | 'unsafe-entry'
        | 'unpack-failed'
        | 'incomplete'
        | CaseBundleImportProblem
        | 'destination-unusable'
      detail?: string
      problematic?: { missing: string[]; checksumMismatch: string[]; unexpected: string[] }
    }

/** Finds the single bundle directory an archive is supposed to contain. */
const findBundleDir = async (root: string): Promise<string | null> => {
  const entries = await readdir(root, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory())
  if (directories.length !== 1) return null
  return join(root, directories[0].name)
}

export const installCaseFromMarketplace = async (
  entry: CaseMarketplaceEntry,
  options: {
    targetDir: string
    fetchImpl?: CaseMarketplaceFetch
    scratchRoot?: string
  }
): Promise<CaseInstallResult> => {
  const scratch = await mkdtemp(join(options.scratchRoot ?? tmpdir(), 'ps-case-'))
  try {
    const archiveFile = join(scratch, 'case.tar.gz')
    const download = await downloadCaseArchive(entry.bundleUrl, archiveFile, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    })
    if (!download.ok) {
      return {
        ok: false,
        problem: download.problem,
        ...(download.detail === undefined ? {} : { detail: download.detail })
      }
    }
    if (download.sha256 !== entry.bundleSha256) {
      return {
        ok: false,
        problem: 'checksum-mismatch',
        detail: `${download.sha256} ≠ ${entry.bundleSha256}`
      }
    }

    const unpacked = await unpackCaseArchive(archiveFile, join(scratch, 'unpacked'))
    if (!unpacked.ok) {
      return {
        ok: false,
        problem: unpacked.problem,
        ...(unpacked.detail === undefined ? {} : { detail: unpacked.detail })
      }
    }
    const bundleDir = await findBundleDir(unpacked.directory)
    if (bundleDir === null) {
      return {
        ok: false,
        problem: 'invalid-bundle',
        detail: 'expected exactly one bundle directory'
      }
    }

    const read = await importCaseBundle(bundleDir)
    if (!read.ok) {
      return {
        ok: false,
        problem: read.problem === 'incomplete' ? 'incomplete' : 'invalid-bundle',
        ...(read.detail === undefined ? {} : { detail: read.detail }),
        ...(read.problematic === undefined ? {} : { problematic: read.problematic })
      }
    }

    const written = await materialiseCaseBundle(bundleDir, options.targetDir)
    if (!written.ok) {
      return {
        ok: false,
        problem: written.problem,
        ...(written.detail === undefined ? {} : { detail: written.detail })
      }
    }
    return {
      ok: true,
      name: read.bundle.manifest.name,
      fileCount: read.bundle.manifest.files.length,
      totalBytes: read.bundle.totalBytes,
      bundleDir,
      installedTo: written.directory
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export type CaseArchivePackResult =
  | { ok: true; archiveFile: string; sha256: string; bytes: number }
  | { ok: false; problem: 'unpackable'; detail?: string }

/** Publishing side: a bundle directory becomes the one archive the index can name. */
export const packCaseArchive = async (
  bundleDir: string,
  archiveFile: string
): Promise<CaseArchivePackResult> => {
  const folder = bundleDir.split('/').pop()
  if (!folder) return { ok: false, problem: 'unpackable', detail: 'bundleDir' }
  await mkdir(dirname(archiveFile), { recursive: true })
  try {
    // The archive carries the bundle directory itself, so unpacking it yields a directory the reader accepts.
    await tar.c({ gzip: true, file: archiveFile, cwd: join(bundleDir, '..') }, [folder])
  } catch (error) {
    return { ok: false, problem: 'unpackable', detail: String(error) }
  }
  const size = await stat(archiveFile)
  const hash = createHash('sha256')
  await pipeline(createReadStream(archiveFile), hash)
  return { ok: true, archiveFile, sha256: hash.digest('hex'), bytes: size.size }
}
