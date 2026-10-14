import { z } from 'zod'

// E1 (v2.3.0, the plugin creator's first slice): a THIRD-PARTY public repository as a plugin source.
//
// Why this is its own artifact rather than a Specialist package: that format is deliberately closed —
// `manifest.json` is application-generated metadata and its rules REJECT dependency declarations outright
// ("dependency declarations are not supported", specialist-diagnostics). A plugin source is the opposite:
// the whole point is that the repository DECLARES the tools and the runtime it needs, and that a reader can
// check the declaration against what was actually fetched. The two formats stay separate on purpose.
//
// The file name is new (no existing name fits: the Specialist one is reserved for its own closed format), so
// it is stated here once and every reader of this module uses this constant.

export const PLUGIN_MANIFEST_FILENAME = 'purescience-plugin.json'

/** A parsed reference to a public repository: owner, repository, ref (branch/tag/sha) and manifest path. */
export type PluginSourceRef = {
  owner: string
  repo: string
  ref: string
  path: string
}

export type PluginSourceRefParse =
  | { state: 'available'; ref: PluginSourceRef }
  | { state: 'unavailable'; reason: 'invalid-reference'; detail: string }

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/
// Dots are allowed inside a name (a repository is often `foo.js`), but a segment that IS a dot or a
// double dot is a traversal, not a name: the marketplace protocol refuses those two for the same
// reason, and a plugin reference is no different.
const isSafeSegment = (segment: string): boolean =>
  segment !== '.' && segment !== '..' && SAFE_SEGMENT.test(segment)

/**
 * Parses what a user typed. Two shapes are accepted, both explicit about the host — an unqualified
 * `owner/repo` is refused rather than guessed at, because guessing a host is guessing a source of code:
 *   - https://github.com/<owner>/<repo>(.git)?(@<ref>)?(/tree/<ref>)?(/<path…>)?
 *   - github:<owner>/<repo>(@<ref>)?(/<path…>)?
 * `ref` defaults to `HEAD` (the host resolves it), and the manifest path defaults to the repository root.
 */
export const parsePluginSourceReference = (input: string): PluginSourceRefParse => {
  const raw = input.trim()
  if (raw === '') {
    return { state: 'unavailable', reason: 'invalid-reference', detail: 'No reference was given.' }
  }

  let owner = ''
  let repo = ''
  let ref = ''
  let rest = ''

  const short = /^github:([^/]+)\/([^/@]+)(?:@([^/]+))?(?:\/(.*))?$/.exec(raw)
  if (short) {
    owner = short[1]
    repo = short[2].replace(/\.git$/, '')
    ref = short[3] ?? ''
    rest = short[4] ?? ''
  } else {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return {
        state: 'unavailable',
        reason: 'invalid-reference',
        detail: 'Name the host explicitly: a github.com URL or github:owner/repo[@ref][/path].'
      }
    }
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')
    ) {
      return {
        state: 'unavailable',
        reason: 'invalid-reference',
        detail: `Only https://github.com is accepted here; got ${url.protocol}//${url.hostname}.`
      }
    }
    const segments = url.pathname.split('/').filter((segment) => segment !== '')
    if (segments.length < 2) {
      return {
        state: 'unavailable',
        reason: 'invalid-reference',
        detail: 'A repository needs an owner and a name: https://github.com/<owner>/<repo>.'
      }
    }
    owner = segments[0]
    repo = segments[1].replace(/\.git$/, '')
    // /tree/<ref>/<path…> and /blob/<ref>/<path…> are the shapes a browser link has; take the ref out of them.
    if (segments[2] === 'tree' || segments[2] === 'blob') {
      if (segments.length < 4) {
        return {
          state: 'unavailable',
          reason: 'invalid-reference',
          detail: `A ${segments[2]} link needs a ref after it.`
        }
      }
      ref = segments[3]
      rest = segments.slice(4).join('/')
    } else if (segments.length > 2) {
      rest = segments.slice(2).join('/')
    }
    if (url.search !== '' || url.hash !== '') {
      return {
        state: 'unavailable',
        reason: 'invalid-reference',
        detail:
          'Drop the query and the fragment: the reference names a repository, nothing dynamic.'
      }
    }
  }

  if (!isSafeSegment(owner) || !isSafeSegment(repo)) {
    return {
      state: 'unavailable',
      reason: 'invalid-reference',
      detail: `Owner and repository may only hold letters, digits, dot, dash and underscore: ${owner}/${repo}.`
    }
  }
  const refValue = ref === '' ? 'HEAD' : ref
  if (!isSafeSegment(refValue)) {
    return {
      state: 'unavailable',
      reason: 'invalid-reference',
      detail: `The ref may only hold letters, digits, dot, dash and underscore: ${refValue}.`
    }
  }
  if (rest !== '' && !rest.split('/').every(isSafeSegment)) {
    return {
      state: 'unavailable',
      reason: 'invalid-reference',
      detail: `The manifest path must be made of safe segments: ${rest}`
    }
  }

  return {
    state: 'available',
    ref: {
      owner,
      repo,
      ref: refValue,
      // A path that already names a .json file is taken as the manifest itself; otherwise the path is a
      // directory and the default file name applies. Both are visible in the preview, so a reader always
      // knows which file the bytes came from.
      path:
        rest === ''
          ? PLUGIN_MANIFEST_FILENAME
          : rest.endsWith('.json')
            ? rest
            : `${rest}/${PLUGIN_MANIFEST_FILENAME}`
    }
  }
}

/**
 * The URLs a manifest is fetched from, in order. The same idea as the official marketplace's source list:
 * a plain raw host first, then CDN mirrors, so one slow or blocked host does not decide whether a reader
 * can look at a public repository. Every URL is a function of the ref alone — nothing is guessed at fetch
 * time, so a reader can recompute all of them from the reference.
 */
export const pluginSourceManifestUrls = (ref: PluginSourceRef): string[] => [
  `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.ref}/${ref.path}`,
  `https://cdn.jsdelivr.net/gh/${ref.owner}/${ref.repo}@${ref.ref}/${ref.path}`
]

/**
 * The URLs one declared entry is read from when the plugin is deployed. Same hosts, same order, and
 * the same property: every URL is a function of the reference and the entry path, so a reader can
 * recompute where the bytes came from.
 */
export const pluginSourceEntryUrls = (
  ref: Pick<PluginSourceRef, 'owner' | 'repo' | 'ref'>,
  entry: string
): string[] => [
  `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.ref}/${entry}`,
  `https://cdn.jsdelivr.net/gh/${ref.owner}/${ref.repo}@${ref.ref}/${entry}`
]

/**
 * What a plugin id may be. It is a single path segment by construction, and it is exported rather than
 * inlined in the schema below because the catalogue's removal path checks the same rule before it joins a
 * directory name: one definition, so a name that deployed is a name that can be removed.
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/

/** What a repository declares. Strict on purpose: an unknown key is refused, not ignored. */
export const pluginManifestSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(PLUGIN_ID_PATTERN),
    display_name: z.string().min(1).max(160),
    summary: z.string().min(1).max(500),
    license: z.string().min(1).max(128),
    runtime: z
      .object({
        kind: z.enum(['node', 'python']),
        version: z.string().min(1).max(32).optional()
      })
      .strict(),
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
            description: z.string().min(1).max(500),
            entry: z.string().min(1).max(256)
          })
          .strict()
      )
      .min(1)
      .max(64)
  })
  .strict()

export type PluginManifest = z.infer<typeof pluginManifestSchema>

export type PluginManifestParse =
  | { state: 'available'; manifest: PluginManifest }
  | { state: 'unavailable'; reason: 'manifest-invalid'; issues: string[] }

/** Parses the fetched bytes. A refusal names every issue, one per line, with its path. */
export const parsePluginManifest = (bytes: Uint8Array): PluginManifestParse => {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch (cause) {
    return {
      state: 'unavailable',
      reason: 'manifest-invalid',
      issues: [`The file is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`]
    }
  }
  const parsed = pluginManifestSchema.safeParse(json)
  if (parsed.success) return { state: 'available', manifest: parsed.data }
  return {
    state: 'unavailable',
    reason: 'manifest-invalid',
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
    )
  }
}

// ── E2: the preview a window holds before anything is deployed ────────────────────────────────────────
//
// The existing Specialist import flow binds a preview to an opaque `candidateToken`, and this follows it for
// the same reason: a later step has to act on exactly what was shown, not on whatever a second fetch would
// return. The token therefore carries the digest of the bytes that were read, and the deploy step (E3) checks
// it against what it fetches before anything runs.

// Generic over the preview a caller holds, so this module never has to know the main process's shape:
// the store binds it to the plugin preview, exactly as the Specialist import flow binds its own.
/**
 * The reading a preview reports: what the manifest declares, and the digest and size of the bytes that were
 * actually read, so a reader recomputes the reading instead of trusting it. This is DATA, so it lives here
 * and both sides use it — the main process produces it, the window's contract declares it.
 */
export type PluginFetchOutcome =
  { ok: true; bytes: Uint8Array } | { ok: false; status: number; detail?: string }

export type PluginSourcePreview =
  | {
      state: 'available'
      source: {
        owner: string
        repo: string
        ref: string
        manifestUrl: string
        manifestPath: string
      }
      manifest: PluginManifest
      fetched: { bytes: number; sha256: string }
    }
  | {
      state: 'unavailable'
      reason: 'invalid-reference' | 'manifest-missing' | 'source-unreachable' | 'manifest-invalid'
      detail?: string
      issues?: string[]
      url?: string
      /** Present exactly when bytes were read: a reader checks what was fetched, most of all when the
       * content is then refused. */
      fetched?: { bytes: number; sha256: string }
    }

export type PluginSourceCandidatePreview<P> = P & { candidateToken: string }

/**
 * What a declaration is checked against BEFORE anything is deployed or executed: the app's own runtime kinds,
 * and the shape of the entries a tool would be run from. Every refusal names the field and why.
 */
export type PluginDeclarationCheck =
  | { state: 'ok' }
  | {
      state: 'refused'
      reason: 'runtime-unsupported' | 'entry-unsafe' | 'tool-name-duplicated'
      detail: string
    }

export const PLUGIN_SUPPORTED_RUNTIMES = ['node', 'python'] as const

const SAFE_ENTRY = /^[A-Za-z0-9._/-]+$/

export const checkPluginDeclaration = (manifest: PluginManifest): PluginDeclarationCheck => {
  if (!(PLUGIN_SUPPORTED_RUNTIMES as readonly string[]).includes(manifest.runtime.kind)) {
    return {
      state: 'refused',
      reason: 'runtime-unsupported',
      detail: `runtime.kind: the app runs ${PLUGIN_SUPPORTED_RUNTIMES.join(' and ')}; this declares ${manifest.runtime.kind}.`
    }
  }

  const seen = new Set<string>()
  for (const tool of manifest.tools) {
    if (seen.has(tool.name)) {
      return {
        state: 'refused',
        reason: 'tool-name-duplicated',
        detail: `tools: "${tool.name}" is declared twice; a name has to identify one tool.`
      }
    }
    seen.add(tool.name)
    // The entry is a path inside the repository, and it is checked as a path: no traversal segment, no
    // absolute path, no empty segment. A declaration that points outside the repository is refused here,
    // before anything is fetched for execution.
    const segments = tool.entry.split('/')
    const unsafe =
      tool.entry.startsWith('/') ||
      tool.entry === '' ||
      !SAFE_ENTRY.test(tool.entry) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    if (unsafe) {
      return {
        state: 'refused',
        reason: 'entry-unsafe',
        detail: `tools.${tool.name}.entry: "${tool.entry}" is not a safe path inside the repository.`
      }
    }
  }

  return { state: 'ok' }
}

/**
 * What the window is told after it asks to deploy or to run once.
 *
 * Codes and parameters only: the sentences a reader sees are the renderer's, keyed by these states, so the
 * main process never has to own prose. `refused.reason` is the gate's own reason string, and it is passed
 * through verbatim rather than mapped.
 */
export type PluginOperationOutcomeView =
  | {
      state: 'deployed'
      pluginId: string
      directory: string
      entries: { entry: string; bytes: number; sha256: string }[]
    }
  | {
      state: 'ran'
      command: string
      exitCode: number | null
      signal: string | null
      timedOut: boolean
      stdout: string
      stderr: string
      durationMs: number
    }
  | { state: 'refused'; reason: string; detail: string }

// ── E3-2 follow-up: the deployed-plugin catalogue ────────────────────────────────────────────────────
//
// Deploying used to be a one-way door. The files were on disk, the record was inside them, and no surface
// could list or remove them — so deploying the same id again was refused with "remove it first" and there
// was nothing in the app that could remove it. This is the read side of the same feature: nothing here
// fetches, and nothing here runs a plugin.
//
// Two rules shape it. A row reports what the app ITSELF recorded (per-entry bytes and sha256 out of
// `deployed.json`) plus the directory's measured size, so a reader can recompute the row rather than trust
// it. And removal answers "did this app deploy this?" before deleting anything: a directory without that
// record is refused BY NAME, because removing a directory the app did not create is not this feature.

/** One declared entry as the deployment recorded it: the bytes written, and their digest. */
export type DeployedPluginEntry = { entry: string; bytes: number; sha256: string }

/**
 * One deployed plugin. `deployed` carries the record; the two other states are named absences rather than
 * empty rows, so "no record here" cannot be read as "a plugin with nothing in it".
 */
export type DeployedPluginView =
  | {
      state: 'deployed'
      pluginId: string
      directory: string
      /** From `deployed.json`. Absent when the record predates the field — a named absence, not a guess. */
      deployedAt?: string
      entries: DeployedPluginEntry[]
      /** Measured from the filesystem when this listing was taken, so it can be compared with `du`. */
      onDiskBytes: number
    }
  | { state: 'record-missing'; pluginId: string; directory: string; onDiskBytes: number }
  | { state: 'record-unreadable'; pluginId: string; directory: string; detail: string }

/** `remove` names one plugin and says whether the reader confirmed the act in words it was shown. */
export type PluginCatalogRequest =
  { action: 'list' } | { action: 'remove'; pluginId: string; confirmed: boolean }

export type PluginCatalogRemovalView =
  | { state: 'removed'; pluginId: string; freedBytes: number }
  /** The directory is not there. Nothing was freed because nothing was found — not the same as 0 bytes. */
  | { state: 'absent'; pluginId: string }
  | {
      state: 'refused'
      reason:
        'unsafe-plugin-id' | 'not-a-deployed-plugin' | 'confirmation-missing' | 'removal-failed'
      detail: string
      /** 0 exactly because nothing was removed; a refusal never reports bytes it did not free. */
      freedBytes: 0
    }

/**
 * The answer to either action. Discriminated by `action` so a caller cannot read a listing out of a
 * removal (or the reverse) by accident.
 */
export type PluginCatalogResult =
  | { action: 'list'; plugins: DeployedPluginView[] }
  | { action: 'remove'; removal: PluginCatalogRemovalView }
