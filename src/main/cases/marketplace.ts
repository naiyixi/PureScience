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
import { basename, dirname, join } from 'node:path'
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

/**
 * The network layer's own message, plus the cause chain it hides behind one line. Undici answers a refused or
 * unreachable endpoint with `TypeError: fetch failed` and puts the actionable part (`connect ETIMEDOUT 10.255.255.1:443`,
 * `EAI_AGAIN`) in `cause` — measured on this machine: a reader who only saw the refusal got "fetch failed" and nothing
 * about what failed. Bounded depth, because a cause chain can be a cycle or arbitrarily long.
 */
const describeFetchError = (error: unknown): string => {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (current.message) parts.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.length > 0 ? parts.join(' ← ') : String(error)
}

export const fetchCaseMarketplaceIndex = async (
  url: string,
  options: { fetchImpl?: CaseMarketplaceFetch; timeoutMs?: number } = {}
): Promise<CaseMarketplaceFetchResult> => {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as CaseMarketplaceFetch)
  const budgetMs = options.timeoutMs ?? CASE_MARKETPLACE_TIMEOUT_MS
  // One budget for the whole document, not one per stage. Headers arriving is not the read finishing, and with a
  // deadline per stage a server that sent headers and then stalled held the reader for two full deadlines while the
  // reported name said "20 s". The same signal therefore covers the body read: when the budget expires the body
  // stream itself errors, instead of the body read starting with a fresh clock.
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, budgetMs)
  const timedOut = (): CaseMarketplaceFetchResult => ({
    ok: false,
    problem: 'unreachable',
    // Not the abort message: "This operation was aborted" says what we did, not what happened or for how long.
    detail: `timed-out after ${budgetMs}ms`
  })
  try {
    let response
    try {
      response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    } catch (error) {
      return expired
        ? timedOut()
        : { ok: false, problem: 'unreachable', detail: describeFetchError(error) }
    }
    if (!response.ok)
      return { ok: false, problem: 'bad-response', detail: `HTTP ${response.status}` }

    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > CASE_MARKETPLACE_INDEX_BYTES_LIMIT) {
      return { ok: false, problem: 'too-large', detail: `${declared}` }
    }

    let text: string
    try {
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
      text = Buffer.concat(chunks).toString('utf8')
    } catch (error) {
      const message = String(error)
      if (message.includes('too-large')) return { ok: false, problem: 'too-large' }
      return expired ? timedOut() : { ok: false, problem: 'bad-response', detail: message }
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
  } finally {
    clearTimeout(timer)
  }
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
        // Both separators: an archive is posix-named, but the filter is the last line of defence on a host where
        // the extractor may hand back native separators, and a traversal is a traversal either way.
        const segments = entryPath.split(/[\\/]+/).filter((segment) => segment.length > 0)
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
  // `basename`, not `split('/')`: on Windows a bundle directory arrives as `C:\…\out\<name>`, which splitting on a
  // forward slash leaves whole — the archive then carried the publisher's absolute path and every reader unpacked
  // a `Users\…` tree instead of the one bundle directory it looks for. Verified by the Windows lane: two installs
  // refused a bundle this code had just packed.
  const folder = basename(bundleDir)
  if (!folder || folder === '.' || folder === '..') {
    return { ok: false, problem: 'unpackable', detail: 'bundleDir' }
  }
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
