import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { DownloadProgress } from '../../shared/download-progress'
import { netFetchStandard } from '../skills/net-fetch'
import {
  downloadWithMirrorFallback,
  isVendorMirrorHost,
  mirrorCandidatesFor
} from '../net/source-mirrors'

import {
  manifestUrl,
  packId,
  PACK_PATH_BUDGET_FILE,
  packArchiveFile,
  packUrl,
  parseManifest,
  pathBudgetForPack,
  resolvePack,
  sha256File,
  SUPPORTED_SCHEMA,
  verifyPackChecksum,
  type BundleManifest,
  type PackEntry,
  type PackLanguage
} from './bundle-manifest'
import type { EnvSpec, FetchedBundle, ProvisionProgress } from './provisioner'
import { extractPackArchiveWithDeps } from './pack-archive'
import { validateAndSeedPack } from './pack-content'
import { runtimePackDir, runtimeSubdir } from './runtime-paths'
import { operationJournalPath, RuntimeOperationJournal } from './operation-journal'

// Client fetch helper for one curated language pack (split-language-pack protocol, multi-version).
// Given the CDN inputs the runtime already has (cdnBase, envVersion, conda subdir) plus the chosen
// language+version, it fetches the shared manifest, resolves the single matching pack archive,
// downloads ONLY that archive, and verifies it against the manifest (fail-closed). It does NOT
// create/materialize an env — that wiring lives in the provisioner and is added in a later step.
// Deps are injected so this unit-tests without real network or hashing.
// Machine-level archive cache. A runner (or a person with several data roots) otherwise re-downloads the
// same curated pack once per environment: the Windows P0 lane spent 6 x ~100 MB per run that way, and one
// slow transfer was enough to blow a spec's whole budget (`artifacts:replay-version` reported
// `durationMs: 565644` with the pack fetch immediately before it — see
// docs/evidence/2026-11-24-windows-gate-second-reading-and-the-transfer-that-cost-it.md).
//
// The env var names the cache root; unset means "no cache", so an ordinary install keeps exactly the
// behaviour it had. The manifest is still fetched from the network on every attempt, and its sha256 is
// still the only thing that decides whether cached bytes are accepted: a cache hit that fails the digest
// is discarded and the download runs as before. So a warm cache removes the transfer, never the check.
export const RUNTIME_PACK_CACHE_ENV = 'PURESCIENCE_RUNTIME_PACK_CACHE'

export const resolvePackArchiveCacheDir = (
  env: NodeJS.ProcessEnv = process.env
): string | undefined => {
  const value = env[RUNTIME_PACK_CACHE_ENV]?.trim()
  return value ? value : undefined
}

export type LanguagePackFetchDeps = {
  // Fetches a URL and returns its body as text (used for manifest.json).
  fetchText: (url: string) => Promise<string>
  // Where verified archives are reused from / copied to. Undefined disables the cache (the default);
  // callers that want it pass resolvePackArchiveCacheDir() or a test directory.
  cacheDir?: string
  // Injection seam for the copy that seeds / serves the cache; defaults to fs.copyFile.
  copyArchive?: (from: string, to: string) => Promise<void>
  // Downloads a URL to destPath (the pack archive). `expected` carries the manifest sha256/size so the
  // resilient core can verify inline and resume against the right total. Short-read detection needs a
  // total, so callers must supply `expected.size` when the response may omit Content-Length.
  // Cancellation is handled by the closure-captured signal in the default adapter, not a parameter.
  download: (
    url: string,
    destPath: string,
    onProgress?: (p: DownloadProgress) => void,
    expected?: { sha256?: string; size?: number }
    // May return where the bytes came from ('origin' or a mirror host). Fakes that return nothing are
    // treated as origin, which is what a test double stands for.
  ) => Promise<string | void>
  // sha256 hex of a file; injectable for tests, defaults to the streaming sha256File.
  sha256?: (path: string) => Promise<string>
}

// The manifest is tiny, so a total request timeout is fine. Without it, a CDN that accepts the
// connection then stalls would hang first-run provisioning (and the serialized provision queue behind
// it) forever instead of failing closed.
const MANIFEST_TIMEOUT_MS = 30_000
// The pack can be large (hundreds of MB), so a total timeout would wrongly kill a legit slow download.
// Use a STALL timeout instead: abort only when no bytes arrive for this window (covers a stalled
// connect and a mid-stream stall alike), and reset it on every received chunk.
const PACK_STALL_TIMEOUT_MS = 60_000

// Combines the internal timeout/stall controller with an optional external cancel signal (user
// pressing Cancel), so either one aborts the request. AbortSignal.any short-circuits if the external
// signal is already aborted.
const withCancel = (internal: AbortSignal, external?: AbortSignal): AbortSignal =>
  external ? AbortSignal.any([internal, external]) : internal

// The manifest is the one request with no second chance: the pack archive already falls back to the
// measured mirror hosts (`downloadWithMirrorFallback`), but the manifest — which carries the digests that
// make that fallback safe — was fetched from the origin alone. On 2026-11-23 a Windows runner lost
// `github.com` outright (`net::ERR_CONNECTION_TIMED_OUT` on
// `releases/download/runtime-v1/win-64-manifest.json`) and first-run provisioning failed with nothing else
// tried, while the very same release assets were being served by mirror hosts the download path already
// trusts. So the manifest now walks the same candidate list.
//
// Origin is always asked FIRST and its bytes win whenever it answers: the mirrors exist for reachability,
// not for correctness. A mirror-served manifest is therefore only possible when the origin did not answer,
// and the host that served it travels back with the text so the progress line can name it (a fallback the
// user cannot see is a fallback that reads as an origin download).
export type ManifestFetchDeps = {
  /** Injected so the candidate walk is unit-testable without a network. */
  fetchStandard?: (
    url: string,
    init: { signal: AbortSignal }
  ) => Promise<{
    ok: boolean
    status: number
    text: () => Promise<string>
  }>
  /** Injected so a test can name the hosts without depending on the live mirror table. */
  candidates?: (url: string) => { url: string; host: string }[]
}

export const fetchManifestText = async (
  url: string,
  external?: AbortSignal,
  deps: ManifestFetchDeps = {}
): Promise<{ text: string; via: string }> => {
  const fetchStandard = deps.fetchStandard ?? netFetchStandard
  const all = (deps.candidates ?? mirrorCandidatesFor)(url)
  // Our own host goes FIRST (it carries the same trust as the origin and is the fast hop in China), then the
  // origin, then third parties. A manifest we serve ourselves must not queue behind a 30 s timeout against a
  // host that answers nowhere.
  const vendor = all.filter((candidate) => isVendorMirrorHost(candidate.host))
  const thirdParty = all.filter((candidate) => !isVendorMirrorHost(candidate.host))
  const candidates: { url: string; host: string }[] = [
    ...vendor,
    { url, host: new URL(url).hostname },
    ...thirdParty
  ]
  const failures: string[] = []
  for (const candidate of candidates) {
    const signal = withCancel(AbortSignal.timeout(MANIFEST_TIMEOUT_MS), external)
    try {
      // Electron net.fetch so the manifest request honors the system/VPN proxy, matching the pack download.
      const response = await fetchStandard(candidate.url, { signal })
      if (!response.ok) {
        failures.push(`${candidate.host} answered ${response.status}`)
        continue
      }
      return { text: await response.text(), via: candidate.host }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${candidate.host}: ${reason}`)
    }
  }
  // Every candidate named: a provisioning failure has to say who was asked and what each one said, or the
  // next reader blames the runtime instead of the network (that is exactly what happened above).
  throw new Error(`runtime manifest request failed (${failures.join('; ')})`)
}

// Default download implementation: delegates to the shared resilient core with Electron net.fetch so
// downloads honor the system/VPN proxy and gain Range resume + retry + stall handling. Verifies the
// pack's sha256 inline when the caller passes it (fetchLanguagePack does, from the manifest entry).
// Tests inject a fake via LanguagePackFetchDeps.download.
const downloadFile = async (
  url: string,
  destPath: string,
  onProgress: (p: DownloadProgress) => void = () => undefined,
  external?: AbortSignal,
  expected?: { sha256?: string; size?: number }
): Promise<string> => {
  // P0-8: the same call, now with the measured mirror table as a second hop. The digest above is what makes
  // this safe — a mirror serving different bytes fails the same checksum an origin would, so a fallback can
  // never turn a loud failure into quiet wrong data. Without a digest the helper does not fall back at all.
  const { via } = await downloadWithMirrorFallback(url, destPath, {
    expectedSha256: expected?.sha256,
    expectedSize: expected?.size,
    stallTimeoutMs: PACK_STALL_TIMEOUT_MS,
    signal: external,
    onProgress,
    deps: { fetchImpl: netFetchStandard }
  })
  // `via` names where the bytes actually came from ('origin' or the mirror host). It travels up with the
  // fetch result so a mirrored pack can never read as an origin one — a silent fallback would make the two
  // indistinguishable, which is exactly what this whole mechanism must not do.
  return via
}

// The result of a successful pack fetch: the resolved id/entry and where the verified file landed.
export type FetchedLanguagePack = {
  id: string
  entry: PackEntry
  filePath: string
  manifest: BundleManifest
  /** Where the bytes came from: 'origin', or the mirror host that served them. Always present. */
  via: string
  /** True when the archive was copied from the machine cache instead of transferred. The digest is the
   * same either way; this flag only exists so the progress line can say which one happened. */
  fromCache: boolean
}

// A cache hit has to pass the very digest the download would have had to pass. `false` means the cached
// copy is unusable (absent, wrong size, wrong bytes) and the caller downloads instead — so a stale or
// truncated cache can only cost time, never correctness.
const cachedArchiveIsIntact = async (
  cachePath: string,
  entry: PackEntry,
  sha256: (path: string) => Promise<string>
): Promise<boolean> => {
  try {
    const info = await stat(cachePath)
    if (!info.isFile()) return false
    if (info.size !== entry.size) return false
    return (await sha256(cachePath)) === entry.sha256
  } catch {
    return false
  }
}

// Copies an already-verified archive into the machine cache. Best effort by design: a cache that cannot be
// written must never fail a fetch whose bytes we already hold — the worst case is the next environment
// transferring them again. Staged under a unique name and renamed, so a half-written cache file can never
// be mistaken for a complete one.
const seedArchiveCache = async (
  cachePath: string,
  sourcePath: string,
  copy: (from: string, to: string) => Promise<void>
): Promise<void> => {
  const staging = `${cachePath}.${randomUUID()}.part`
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await copy(sourcePath, staging)
    await rename(staging, cachePath)
  } catch {
    await rm(staging, { force: true }).catch(() => undefined)
  }
}

// Fetches + verifies the single pack for (language, version). Throws (fail-closed) when the manifest
// is malformed, its schema/envVersion disagree with what the runtime expects, the requested version
// was not published, or the downloaded pack fails its sha256/size check — the CDN adapter treats any
// throw as unavailable and the provisioner emits an actionable no-source error.
export const fetchLanguagePack = async (
  destDir: string,
  cdnBase: string,
  version: number,
  subdir: string,
  language: PackLanguage,
  packVersion: string,
  deps: LanguagePackFetchDeps,
  onDownloadProgress: (p: DownloadProgress) => void = () => undefined
): Promise<FetchedLanguagePack> => {
  const manifest = parseManifest(await deps.fetchText(manifestUrl(cdnBase, version, subdir)))
  if (manifest.schema !== SUPPORTED_SCHEMA) {
    throw new Error(`unsupported manifest schema ${manifest.schema} (expected ${SUPPORTED_SCHEMA})`)
  }
  if (manifest.envVersion !== version) {
    throw new Error(`manifest envVersion ${manifest.envVersion} does not match expected ${version}`)
  }
  if (manifest.subdir !== subdir) {
    throw new Error(`manifest subdir ${manifest.subdir} does not match expected ${subdir}`)
  }
  const entry = resolvePack(manifest, language, packVersion)
  if (!entry) {
    throw new Error(`no ${language} ${packVersion} pack in manifest for subdir ${subdir}`)
  }
  const canonicalFile = packArchiveFile(language, packVersion)
  if (entry.file !== canonicalFile) {
    throw new Error(
      `runtime manifest uses a non-canonical pack filename for ${language}-${packVersion}`
    )
  }
  const filePath = join(destDir, canonicalFile)
  const cachePath = deps.cacheDir
    ? join(deps.cacheDir, subdir, String(version), canonicalFile)
    : undefined
  const copyArchive = deps.copyArchive ?? ((from: string, to: string) => copyFile(from, to))
  const sha256 = deps.sha256 ?? sha256File
  const fromCache = cachePath ? await cachedArchiveIsIntact(cachePath, entry, sha256) : false
  let via: string
  if (fromCache) {
    await mkdir(destDir, { recursive: true })
    await copyArchive(cachePath as string, filePath)
    // No transfer happened, so no progress is invented for one: the caller's line says "from the cache".
    via = 'archive-cache'
  } else {
    via =
      ((await deps.download(
        packUrl(cdnBase, version, subdir, entry.file),
        filePath,
        // Fill in the manifest's pack size when the response omits Content-Length, so the UI still shows
        // a meaningful total/percent instead of an unknown-size bar.
        (p) => onDownloadProgress(p.total != null ? p : { ...p, total: entry.size }),
        { sha256: entry.sha256, size: entry.size }
      )) as string | undefined) ?? 'origin'
  }
  // Defense-in-depth: an independent post-download size+sha256 verification, separate from the inline
  // check the resilient core already performed while streaming. See verifyPackChecksum — this is a
  // required second integrity gate for a large executed artifact, not redundant work. It runs on the
  // machine-cache hop too: the cache decides nothing, the manifest digest does.
  await verifyPackChecksum(
    filePath,
    { sha256: entry.sha256, size: entry.size },
    { sha256: deps.sha256 }
  )
  // Only bytes that just passed the digest are worth keeping: seeding before the check would cache a
  // corrupt archive behind a name the next attempt would then have to distrust.
  if (!fromCache && cachePath) await seedArchiveCache(cachePath, filePath, copyArchive)
  return { id: packId(language, packVersion), entry, filePath, manifest, via, fromCache }
}

export type FetchBundleAdapterDeps = Partial<LanguagePackFetchDeps> & {
  extract?: (archivePath: string, destDir: string) => Promise<void>
  subdir?: string
}

type FetchBundleFn = (
  spec: EnvSpec,
  version: number,
  onProgress: (p: ProvisionProgress) => void,
  signal?: AbortSignal
) => Promise<FetchedBundle | undefined>

// Adapts the single-file CDN fetch to the provisioner's lock-based contract. A failed CDN fetch throws
// one source-scoped, actionable error so HTTP/integrity failures survive through Settings and lazy
// provisioning; no online solve is attempted. An aborted `signal` (user Cancel) aborts the download.
export const createFetchBundleAdapter = (
  root: string,
  cdnBase: string | undefined,
  deps: FetchBundleAdapterDeps = {}
): FetchBundleFn => {
  // One cache namespace per app session (per adapter instance — the provisioner builds it once at
  // startup). A prior session's partial .part therefore lives under a DIFFERENT token and is invisible
  // to this session's fetch, so "app closes → start from scratch" holds by construction — it does not
  // depend on the startup .cache wipe running or succeeding (that wipe is now pure housekeeping, and a
  // corrupt-journal early-return or a failed rm can no longer cause a stale resume). Within a session
  // the token is stable, so a manual retry (no restart) still resumes via Range.
  const sessionCacheKey = randomUUID()
  return async (spec, version, onProgress, signal) => {
    if (!cdnBase) return undefined
    // Stage under <root>/packs (the SAME volume as the final pack dir), NOT the system tmpdir: the
    // final commit is an atomic rename() into runtimePackDir(root,...), and a relocated data root on a
    // separate filesystem would make a tmpdir->root rename fail EXDEV even though the download, verify,
    // and extract all succeeded. Staging on-volume keeps the rename atomic (and avoids dumping a large
    // pack — the R pack is ~345 MB — into system /tmp).
    const packsRoot = join(root, 'packs')
    await mkdir(packsRoot, { recursive: true })
    const workDir = await mkdtemp(join(packsRoot, '.incoming-'))
    const unpackedDir = join(workDir, 'pack')
    // Location for the downloaded archive + its .part. The extraction staging (workDir) is disposable
    // and wiped in the finally, but the .part must OUTLIVE a failed or cancelled fetch WITHIN a session
    // so a manual retry (no restart) resumes via Range instead of restarting a ~345 MB download.
    // Path: .cache/<sessionCacheKey>/<envVersion>/<subdir>/. The session key makes a PRIOR session's
    // .part invisible here ("app closes → start from scratch", independent of the startup wipe); the
    // envVersion+subdir segments keep a stale fragment from a different version/arch from being
    // Range-resumed against a new pack URL (which would only fail checksum after a full re-download).
    const subdir = deps.subdir ?? runtimeSubdir()
    const archiveDir = join(packsRoot, '.cache', sessionCacheKey, String(version), subdir)
    await mkdir(archiveDir, { recursive: true })
    // Crash recovery (WS13): record the download intent BEFORE staging so a hard-quit mid-fetch leaves
    // a journal entry whose targetPath is this .incoming-* dir; startup recovery removes the orphan.
    // Cleared in the finally on every normal completion/failure (the staging is gone by then), so only
    // a killed process leaves it behind. Best-effort — journal I/O never fails the fetch.
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
    const operationId = randomUUID()
    await journal
      .begin({
        operationId,
        kind: 'download',
        runtimeId: packId(spec.language, spec.version),
        phase: `fetch-${spec.language}`,
        startedAt: Date.now(),
        targetPath: workDir
      })
      .catch(() => undefined)
    try {
      onProgress({
        phase: `fetch-${spec.language}`,
        message: 'Fetching managed runtime manifest…',
        progress: 0.05
      })
      // A manifest served by a mirror is said out loud in the progress line: the bytes about to be trusted
      // came from that host, and naming it keeps a fallback from reading as an origin download.
      let manifestVia: string | undefined
      const fetched = await fetchLanguagePack(
        // Download the archive to the stable cache dir (not workDir) so its .part survives for resume.
        archiveDir,
        cdnBase,
        version,
        subdir,
        spec.language,
        spec.version,
        {
          // Bake the external cancel signal into the default fetchers so a user Cancel aborts the
          // in-flight manifest fetch and pack download (injected test deps opt out, as before).
          fetchText:
            deps.fetchText ??
            (async (url) => {
              const manifest = await fetchManifestText(url, signal)
              manifestVia = manifest.via
              return manifest.text
            }),
          download:
            deps.download ??
            ((url, dest, op, expected) => downloadFile(url, dest, op, signal, expected)),
          sha256: deps.sha256,
          // Resolved once per adapter (one per app session): the env var is a machine-level location, not
          // a per-fetch one, and re-reading it mid-session would let two environments disagree about where
          // the cache lives.
          cacheDir: deps.cacheDir ?? resolvePackArchiveCacheDir(),
          copyArchive: deps.copyArchive
        },
        (download) => {
          const ratio =
            download.total && download.total > 0 ? download.transferred / download.total : 0
          const detail =
            download.phase === 'reconnecting'
              ? ' (resuming…)'
              : download.total
                ? ` (${Math.min(100, Math.round(ratio * 100))}%)`
                : download.transferred > 0
                  ? ` (${Math.round(download.transferred / 1024 / 1024)} MB)`
                  : ''
          onProgress({
            phase: `fetch-${spec.language}`,
            message: `Downloading managed ${spec.language} runtime${detail}`,
            progress: 0.1 + 0.25 * Math.min(1, ratio),
            download
          })
        }
      )
      onProgress({
        phase: `fetch-${spec.language}`,
        // A mirrored download says so where the user already reads the progress line — the source is part of
        // the fact, not an implementation detail. Origin downloads keep the message they always had. The
        // manifest host is named too, because it is the document the archive's digest was read from.
        // A cache hit says so: "Downloaded" would claim a transfer that did not happen, and the operator
        // reading a slow-Job log needs to know which of the two paths ran.
        message: fetched.fromCache
          ? `Installed ${fetched.entry.file} from the verified local cache`
          : fetched.via === 'origin'
            ? manifestVia && manifestVia !== 'github.com'
              ? `Downloaded ${fetched.entry.file} (manifest from ${manifestVia})`
              : `Downloaded ${fetched.entry.file}`
            : `Downloaded ${fetched.entry.file} from ${fetched.via}`,
        progress: 0.35
      })

      await extractPackArchiveWithDeps(fetched.filePath, unpackedDir, { extract: deps.extract })
      // The archive is now fully extracted into staging, so the cached copy is no longer needed —
      // remove it (and any stale .part) to reclaim the ~345 MB. Best-effort: a leftover only wastes
      // disk and is overwritten on the next fetch. A download that never reached here keeps its .part.
      await rm(fetched.filePath, { force: true }).catch(() => undefined)
      await rm(`${fetched.filePath}.part`, { force: true }).catch(() => undefined)
      const lockPath = join(unpackedDir, `${fetched.id}.lock`)
      await readFile(lockPath, 'utf8')
      const entries = await validateAndSeedPack(root, unpackedDir, lockPath, (completed, total) => {
        onProgress({
          phase: `fetch-${spec.language}`,
          message: `Verifying ${completed}/${total} packages…`,
          progress: 0.35 + 0.15 * (completed / total)
        })
      })
      if (entries.length === 0) return undefined

      // subdir was resolved once above (used for the version/subdir-keyed archive cache dir).
      const pathBudget = pathBudgetForPack(fetched.entry)
      if (subdir === 'win-64' && !pathBudget) return undefined
      if (pathBudget) {
        await writeFile(
          join(unpackedDir, PACK_PATH_BUDGET_FILE),
          `${JSON.stringify(pathBudget)}\n`,
          'utf8'
        )
      }
      const finalDir = runtimePackDir(root, version, subdir, fetched.id)
      await mkdir(join(finalDir, '..'), { recursive: true })
      try {
        // The pack id is immutable for an envVersion/subdir. Rename the fully verified directory
        // into place first, so readers never observe a partially extracted pack.
        await rename(unpackedDir, finalDir)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error
        try {
          const winnerLockPath = join(finalDir, `${fetched.id}.lock`)
          await validateAndSeedPack(root, finalDir, winnerLockPath)
          // A prior verified immutable fetch won the race; revalidating its lock and tarballs ensures
          // an interrupted directory with only a readable lock cannot masquerade as the winner.
          if (pathBudget) {
            await writeFile(
              join(finalDir, PACK_PATH_BUDGET_FILE),
              `${JSON.stringify(pathBudget)}\n`,
              'utf8'
            )
          }
          return { lockPath: winnerLockPath, pathBudget }
        } catch {
          // Only remove a directory that is demonstrably not a complete pack, then retry the
          // rename. This handles a process interrupted before its final commit.
          await rm(finalDir, { recursive: true, force: true })
          await rename(unpackedDir, finalDir)
        }
      }
      return { lockPath: join(finalDir, `${fetched.id}.lock`), pathBudget }
    } catch (error) {
      const message = `Managed runtime pack unavailable: ${error instanceof Error ? error.message : String(error)}`
      onProgress({
        phase: `fetch-${spec.language}`,
        message,
        progress: 0.1
      })
      throw new Error(message, { cause: error })
    } finally {
      await rm(workDir, { recursive: true, force: true })
      // Staging is gone (committed or cleaned) — clear the journal entry so only a killed process
      // leaves it for startup recovery.
      await journal.complete(operationId).catch(() => undefined)
    }
  }
}
