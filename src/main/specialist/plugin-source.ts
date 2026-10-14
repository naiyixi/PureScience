import { createHash } from 'node:crypto'

import {
  parsePluginManifest,
  parsePluginSourceReference,
  pluginSourceManifestUrls,
  type PluginManifest
} from '../../shared/plugin-source'

// E1: the PREVIEW half of the plugin creator. It fetches what a repository declares and reports what it
// actually got — the bytes' own sha256 and size — so a reader can recompute the reading instead of trusting
// it. It writes nothing: no file, no registration, no environment. Deploying is a separate, later step.
//
// The fetch is injected rather than imported so the module's behaviour (mirror order, refusals, hashing) is
// pinned by tests without a network, and the one real reading is taken deliberately.

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
      /** Present exactly when bytes were read: a reader checks what was fetched, most of all when the
       * content is then refused. */
      fetched?: { bytes: number; sha256: string }
      detail?: string
      issues?: string[]
      url?: string
    }

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export const previewPluginSource = async (
  input: string,
  deps: { fetchBytes: (url: string) => Promise<PluginFetchOutcome> }
): Promise<PluginSourcePreview> => {
  const parsed = parsePluginSourceReference(input)
  // A refused reference costs zero requests: nothing is fetched to find out that the shape was wrong.
  if (parsed.state === 'unavailable') {
    return { state: 'unavailable', reason: 'invalid-reference', detail: parsed.detail }
  }
  const ref = parsed.ref
  const urls = pluginSourceManifestUrls(ref)

  // Every host's answer is kept: "none of them has it" is a claim about ALL of them, and a reader counts
  // the 404s rather than looking at whichever host happened to fail last.
  const failures: Array<{ url: string; status: number }> = []
  for (const url of urls) {
    const outcome = await deps.fetchBytes(url)
    if (!outcome.ok) {
      failures.push({ url, status: outcome.status })
      continue
    }
    const manifest = parsePluginManifest(outcome.bytes)
    if (manifest.state === 'unavailable') {
      return {
        state: 'unavailable',
        reason: 'manifest-invalid',
        url,
        issues: manifest.issues,
        // The bytes that were read, and their digest: refusing the CONTENT must still let a reader verify
        // what arrived — that is the whole point of a recomputable source reading.
        fetched: { bytes: outcome.bytes.byteLength, sha256: sha256(outcome.bytes) }
      }
    }
    return {
      state: 'available',
      source: {
        owner: ref.owner,
        repo: ref.repo,
        ref: ref.ref,
        manifestUrl: url,
        manifestPath: ref.path
      },
      manifest: manifest.manifest,
      // The reading a reader recomputes: the digest and the size of the bytes that were actually read.
      fetched: { bytes: outcome.bytes.byteLength, sha256: sha256(outcome.bytes) }
    }
  }

  const last = failures[failures.length - 1] as { url: string; status: number } | undefined
  const everyHostSaidNotFound =
    failures.length === urls.length && failures.every((failure) => failure.status === 404)
  return {
    state: 'unavailable',
    reason: everyHostSaidNotFound ? 'manifest-missing' : 'source-unreachable',
    detail:
      failures.length === 0
        ? `Tried ${String(urls.length)} host(s); no host answered.`
        : `Tried ${String(urls.length)} host(s); statuses ${failures
            .map((failure) => String(failure.status))
            .join(', ')} (last: ${last?.url ?? ''}).`
  }
}
