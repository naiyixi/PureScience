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

/** What a repository declares. Strict on purpose: an unknown key is refused, not ignored. */
export const pluginManifestSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
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
