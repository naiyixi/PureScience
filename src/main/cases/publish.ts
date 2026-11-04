import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { CaseBundleSourceFile } from '../../shared/case-bundle'
import {
  CASE_MARKETPLACE_INDEX_URL,
  CASE_MARKETPLACE_INDEX_BYTES_LIMIT,
  validateCaseMarketplaceIndex
} from '../../shared/case-marketplace'
import type { CaseMarketplaceEntry, CaseMarketplaceIndex } from '../../shared/case-marketplace'
import {
  CASE_PUBLISH_ID_PATTERN,
  CASE_PUBLISH_INDEX_ASSET,
  CASE_PUBLISH_RELEASE_TAG
} from '../../shared/case-publish'
import type { CasePublishDraft, CasePublishOutcome } from '../../shared/case-publish'
import type { CaseBundleExportInput } from './export-bundle'
import type { CaseArchivePackResult } from './marketplace'

// Publishing a case: the project becomes the same bundle the export button makes, the bundle becomes one archive, the
// archive goes to this repository's `case-index` release, and one entry is upserted into the index document.
//
// The credential is `gh`'s, not ours. If `gh` is absent or logged out, publishing refuses and prints the command that
// would fix it — this app does not ask a user to paste a GitHub token into a research tool, and it does not ship an
// OAuth client of its own just to move a tarball.

const execFileAsync = promisify(execFile)

export const CASE_PUBLISH_HTTP_TIMEOUT_MS = 30_000
const CASE_PUBLISH_UPLOAD_TIMEOUT_MS = 15 * 60_000

export type CasePublishDependencies = {
  /** Same writer the export button uses. */
  exportBundle: (
    input: CaseBundleExportInput
  ) => Promise<
    | { ok: true; bundleDir: string; fileCount: number; totalBytes: number }
    | { ok: false; problem: string; detail?: string }
  >
  packArchive: (bundleDir: string, archiveFile: string) => Promise<CaseArchivePackResult>
  /** Resolves the GitHub token this machine already holds, or null when there is none. */
  readCredential: () => Promise<string | null>
  fetch: typeof fetch
  now: () => number
  /** Where the scratch bundle and archive live while publishing. */
  scratchRoot?: string
}

export type GitHubRelease = { id: number; upload_url: string; tag_name: string }
export type GitHubAsset = { id: number; name: string; browser_download_url: string }

const repoFromIndexUrl = (): { owner: string; repo: string } => {
  // .../naiyixi/PureScience/releases/download/case-index/case-marketplace.json
  const parts = new URL(CASE_MARKETPLACE_INDEX_URL).pathname.split('/').filter(Boolean)
  return { owner: parts[0], repo: parts[1] }
}

/** `gh auth token` is the whole credential story. Absent gh, or gh logged out, means no publishing. */
export const readGitHubCredential = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000 })
    const token = stdout.trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

const api = async (
  deps: CasePublishDependencies,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CASE_PUBLISH_HTTP_TIMEOUT_MS)
  try {
    return await deps.fetch(`https://api.github.com${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(init.headers ?? {})
      }
    })
  } finally {
    clearTimeout(timer)
  }
}

const ensureRelease = async (
  deps: CasePublishDependencies,
  token: string,
  owner: string,
  repo: string
): Promise<{ ok: true; release: GitHubRelease } | { ok: false; detail: string }> => {
  const found = await api(
    deps,
    token,
    `/repos/${owner}/${repo}/releases/tags/${CASE_PUBLISH_RELEASE_TAG}`
  )
  if (found.ok) return { ok: true, release: (await found.json()) as GitHubRelease }
  if (found.status !== 404) return { ok: false, detail: `GET release ${found.status}` }

  const created = await api(deps, token, `/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: CASE_PUBLISH_RELEASE_TAG,
      name: 'Case market index',
      body: 'The index document and one archive per case. Both are assets of this release; nothing here is served by anything else.',
      prerelease: true
    })
  })
  if (!created.ok) return { ok: false, detail: `POST release ${created.status}` }
  return { ok: true, release: (await created.json()) as GitHubRelease }
}

const listAssets = async (
  deps: CasePublishDependencies,
  token: string,
  owner: string,
  repo: string,
  releaseId: number
): Promise<ReadonlyArray<GitHubAsset>> => {
  const response = await api(
    deps,
    token,
    `/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100`
  )
  if (!response.ok) return []
  return (await response.json()) as ReadonlyArray<GitHubAsset>
}

/** Uploads one file as a release asset. Never deletes anything: an asset that is referenced stays readable. */
const uploadAsset = async (
  deps: CasePublishDependencies,
  token: string,
  release: GitHubRelease,
  assetName: string,
  body: ReadableStream<Uint8Array> | string,
  contentType: string,
  contentLength: number
): Promise<{ ok: true; asset: GitHubAsset } | { ok: false; detail: string; status: number }> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CASE_PUBLISH_UPLOAD_TIMEOUT_MS)
  try {
    const uploadUrl = new URL(release.upload_url.replace(/\{.*\}$/, ''))
    uploadUrl.searchParams.set('name', assetName)
    const response = await deps.fetch(uploadUrl.toString(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': contentType,
        // GitHub's upload endpoint rejects a chunked body with 400: the length has to be declared up front.
        'content-length': String(contentLength),
        'x-github-api-version': '2022-11-28'
      },
      body: body as BodyInit,
      // Node needs this to stream a file body without buffering it twice.
      duplex: 'half'
    } as RequestInit)
    if (!response.ok)
      return {
        ok: false,
        detail: `upload ${assetName} ${response.status}`,
        status: response.status
      }
    return { ok: true, asset: (await response.json()) as GitHubAsset }
  } finally {
    clearTimeout(timer)
  }
}

const deleteAssetByName = async (
  deps: CasePublishDependencies,
  token: string,
  owner: string,
  repo: string,
  release: GitHubRelease,
  assetName: string
): Promise<boolean> => {
  const existing = (await listAssets(deps, token, owner, repo, release.id)).find(
    (asset) => asset.name === assetName
  )
  if (!existing) return true
  const removed = await api(deps, token, `/repos/${owner}/${repo}/releases/assets/${existing.id}`, {
    method: 'DELETE'
  })
  return removed.ok || removed.status === 404
}

/**
 * The index has one canonical asset name, and GitHub has no replace: the old asset goes before the new one can take
 * the name. That is a hole — a failed upload between the two leaves the shelf 404ing — so the previous bytes are held
 * and put back if the write does not take.
 */
const writeIndex = async (
  deps: CasePublishDependencies,
  token: string,
  owner: string,
  repo: string,
  release: GitHubRelease,
  next: string,
  previous: string | null
): Promise<{ ok: true } | { ok: false; detail: string }> => {
  const removed = await deleteAssetByName(
    deps,
    token,
    owner,
    repo,
    release,
    CASE_PUBLISH_INDEX_ASSET
  )
  if (!removed) return { ok: false, detail: 'delete failed' }
  const uploaded = await uploadAsset(
    deps,
    token,
    release,
    CASE_PUBLISH_INDEX_ASSET,
    next,
    'application/json',
    Buffer.byteLength(next)
  )
  if (uploaded.ok) return { ok: true }
  if (previous !== null) {
    // Put the shelf back the way it was, so a failed publish is a no-op rather than an outage.
    const restored = await uploadAsset(
      deps,
      token,
      release,
      CASE_PUBLISH_INDEX_ASSET,
      previous,
      'application/json',
      Buffer.byteLength(previous)
    )
    if (!restored.ok) return { ok: false, detail: `${uploaded.detail}; restore ${restored.detail}` }
    return { ok: false, detail: `${uploaded.detail}; previous index restored` }
  }
  return { ok: false, detail: uploaded.detail }
}

const fetchIndex = async (
  deps: CasePublishDependencies,
  source: { token: string; owner: string; repo: string; releaseId: number }
): Promise<
  | { ok: true; index: CaseMarketplaceIndex; raw: string | null }
  | { ok: false; problem: 'index-unreachable' | 'index-unreadable'; detail?: string }
> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CASE_PUBLISH_HTTP_TIMEOUT_MS)
  try {
    // Read the index out of the release over the API instead of from its public download URL. Same bytes, but
    // github.com and api.github.com are different hosts, and the web host is the one that crawls on some networks.
    // What was written and what is read back then travel the same road.
    const assets = await listAssets(deps, source.token, source.owner, source.repo, source.releaseId)
    const asset = assets.find((candidate) => candidate.name === CASE_PUBLISH_INDEX_ASSET)
    // Nothing published yet: the first case starts the document.
    if (!asset) {
      return {
        ok: true,
        index: { format: 'purescience.case-marketplace', version: 1, updatedAt: 0, cases: [] },
        raw: null
      }
    }
    const response = await api(
      deps,
      source.token,
      `/repos/${source.owner}/${source.repo}/releases/assets/${asset.id}`,
      { headers: { accept: 'application/octet-stream' } }
    )
    if (!response.ok)
      return { ok: false, problem: 'index-unreachable', detail: `HTTP ${response.status}` }
    const text = await response.text()
    if (text.length > CASE_MARKETPLACE_INDEX_BYTES_LIMIT) {
      return { ok: false, problem: 'index-unreadable', detail: 'too-large' }
    }
    const verdict = validateCaseMarketplaceIndex(JSON.parse(text) as unknown)
    if (!verdict.ok) {
      return { ok: false, problem: 'index-unreadable', detail: verdict.problem }
    }
    return { ok: true, index: verdict.index, raw: text }
  } catch (error) {
    return { ok: false, problem: 'index-unreachable', detail: String(error) }
  } finally {
    clearTimeout(timer)
  }
}

const metadataComplete = (draft: CasePublishDraft): boolean =>
  [draft.name, draft.domain, draft.summary, draft.author, draft.license].every(
    (value) => typeof value === 'string' && value.trim().length > 0
  )

export type CasePublishInput = {
  draft: CasePublishDraft
  files: ReadonlyArray<CaseBundleSourceFile>
}

export const publishCaseBundle = async (
  input: CasePublishInput,
  deps: CasePublishDependencies
): Promise<CasePublishOutcome> => {
  const draft: CasePublishDraft = {
    ...input.draft,
    id: input.draft.id.trim().toLowerCase()
  }
  if (!CASE_PUBLISH_ID_PATTERN.test(draft.id))
    return { status: 'refused', reason: 'bad-id', detail: draft.id }
  if (!metadataComplete(draft)) return { status: 'refused', reason: 'missing-metadata' }

  const token = await deps.readCredential()
  if (!token) return { status: 'refused', reason: 'no-credential', detail: 'gh auth login' }

  const scratch = await mkdtemp(join(deps.scratchRoot ?? tmpdir(), 'ps-case-publish-'))
  try {
    const exported = await deps.exportBundle({
      caseName: draft.name.trim(),
      domain: draft.domain.trim(),
      summary: draft.summary.trim(),
      destinationDir: join(scratch, 'bundle'),
      files: input.files,
      createdAt: deps.now()
    })
    if (!exported.ok) {
      return { status: 'refused', reason: 'export-failed', detail: String(exported.problem) }
    }

    const archiveFile = join(scratch, `${draft.id}.tar.gz`)
    const packed = await deps.packArchive(exported.bundleDir, archiveFile)
    if (!packed.ok) return { status: 'refused', reason: 'pack-failed', detail: packed.detail }

    const { owner, repo } = repoFromIndexUrl()
    const release = await ensureRelease(deps, token, owner, repo)
    if (!release.ok) return { status: 'refused', reason: 'release-failed', detail: release.detail }

    // Content-addressed name: two publishes of the same case cannot collide, and nothing that a reader might be
    // holding is deleted to make room. The index is the pointer; old archives are garbage, not evidence.
    const archiveAssetName = `${draft.id}-${packed.sha256.slice(0, 16)}.tar.gz`
    const uploaded = await uploadAsset(
      deps,
      token,
      release.release,
      archiveAssetName,
      createReadStream(archiveFile) as unknown as ReadableStream<Uint8Array>,
      'application/gzip',
      packed.bytes
    )
    if (!uploaded.ok) return { status: 'refused', reason: 'upload-failed', detail: uploaded.detail }

    const source = { token, owner, repo, releaseId: release.release.id }
    const current = await fetchIndex(deps, source)
    if (!current.ok) return { status: 'refused', reason: current.problem, detail: current.detail }

    const entry: CaseMarketplaceEntry = {
      id: draft.id,
      name: draft.name.trim(),
      domain: draft.domain.trim(),
      summary: draft.summary.trim(),
      author: draft.author.trim(),
      license: draft.license.trim(),
      bundleUrl: uploaded.asset.browser_download_url,
      bundleSha256: packed.sha256,
      fileCount: exported.fileCount,
      totalBytes: exported.totalBytes,
      publishedAt: deps.now(),
      ...(draft.minAppVersion ? { minAppVersion: draft.minAppVersion } : {})
    }
    const cases = current.index.cases.filter((existing) => existing.id !== draft.id)
    cases.push(entry)
    const document: CaseMarketplaceIndex = {
      format: 'purescience.case-marketplace',
      version: 1,
      updatedAt: deps.now(),
      cases
    }
    const serialized = `${JSON.stringify(document, null, 2)}\n`
    const previousIndex =
      current.index.cases.length > 0 ? JSON.stringify(current.index, null, 2) + '\n' : current.raw
    const written = await writeIndex(
      deps,
      token,
      owner,
      repo,
      release.release,
      serialized,
      previousIndex
    )
    if (!written.ok) {
      return { status: 'refused', reason: 'index-upload-failed', detail: written.detail }
    }

    // Read the published document back: "we sent it" is not "the shelf shows it".
    const verified = await fetchIndex(deps, source)
    if (!verified.ok) return { status: 'refused', reason: 'verify-failed', detail: verified.detail }
    const landed = verified.index.cases.find((candidate) => candidate.id === draft.id)
    if (!landed || landed.bundleSha256 !== packed.sha256) {
      return { status: 'refused', reason: 'verify-failed', detail: landed ? 'digest' : 'missing' }
    }

    // Only now is the old archive unreferenced. Sweeping it is housekeeping, not part of the claim: a failure here
    // must not turn a successful publish into a refusal.
    const previousArchiveName = current.index.cases
      .find((existing) => existing.id === draft.id)
      ?.bundleUrl.split('/')
      .pop()
    if (previousArchiveName && previousArchiveName !== archiveAssetName) {
      await deleteAssetByName(deps, token, owner, repo, release.release, previousArchiveName)
    }

    return {
      status: 'published',
      id: draft.id,
      fileCount: exported.fileCount,
      totalBytes: exported.totalBytes,
      bundleSha256: packed.sha256,
      archiveBytes: (await stat(archiveFile)).size,
      indexUrl: CASE_MARKETPLACE_INDEX_URL,
      verified: true
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
