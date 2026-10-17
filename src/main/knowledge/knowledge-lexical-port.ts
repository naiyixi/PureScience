// The lexical port the knowledge search service asks for (v2.6.0 A1-wire). The store keeps a
// fingerprint per source, not its body, so a query reads the text at query time — the same reason a
// folder document is rendered from disk rather than from a cached copy.
//
// Rules that keep this honest:
//   1. One hit per matching line, carrying the line itself. The search service hashes exactly that
//      text, so an index can never decide what a citation says.
//   2. A source that cannot be read is counted as `pending`, not skipped silently: "we found nothing"
//      and "we could not look" are different answers and the response keeps them apart.
//   3. Bounded in three places (bytes per source, hits per source, sources per query) because a
//      knowledge base is a user's whole library, and an unbounded read is a hang rather than a search.

import type { KnowledgeLexicalHit, KnowledgeLexicalPort } from './knowledge-search-service'
import type { KnowledgeSource } from '../../shared/knowledge'

export type KnowledgeLexicalPortOptions = {
  /** The registered sources, in registration order. */
  listSources(): Promise<KnowledgeSource[]>
  /** Reads a file source's text. Throwing means "could not read", which is counted, never hidden. */
  readFileText(source: KnowledgeSource): Promise<string>
  /** Reads a URL source's body. Absent means URL sources are not searchable in this build. */
  readUrlText?: (source: KnowledgeSource) => Promise<string>
  /** Bytes of file text considered per source. */
  maxBytesPerSource?: number
  /** Matching lines reported per source. */
  maxHitsPerSource?: number
  /** Sources examined per query. */
  maxSources?: number
}

const DEFAULT_MAX_BYTES_PER_SOURCE = 512 * 1024
const DEFAULT_MAX_HITS_PER_SOURCE = 5
const DEFAULT_MAX_SOURCES = 200

export type KnowledgeLexicalPortReading = {
  port: KnowledgeLexicalPort
  /** Exposed for tests and for a caller that wants to explain a coverage number. */
  lastSkipped: () => readonly { sourceId: string; reason: 'unreadable' | 'url-not-searchable' }[]
}

export const createKnowledgeLexicalPort = (
  options: KnowledgeLexicalPortOptions
): KnowledgeLexicalPortReading => {
  const maxBytes = options.maxBytesPerSource ?? DEFAULT_MAX_BYTES_PER_SOURCE
  const maxHits = options.maxHitsPerSource ?? DEFAULT_MAX_HITS_PER_SOURCE
  const maxSources = options.maxSources ?? DEFAULT_MAX_SOURCES
  let skipped: { sourceId: string; reason: 'unreadable' | 'url-not-searchable' }[] = []

  const port: KnowledgeLexicalPort = {
    async query(text: string): Promise<{
      hits: KnowledgeLexicalHit[]
      coverage: { indexed: number; pending: number }
    }> {
      const needle = text.trim().toLowerCase()
      const sources = await options.listSources()
      const examined = sources.slice(0, maxSources)
      skipped = []
      const hits: KnowledgeLexicalHit[] = []

      for (const source of examined) {
        if (needle.length === 0) break
        let body: string
        try {
          if (source.kind === 'file') {
            body = await options.readFileText(source)
          } else if (options.readUrlText) {
            body = await options.readUrlText(source)
          } else {
            // Not an error: URL sources are simply outside this build's search surface, and saying so
            // is different from pretending they matched nothing.
            skipped.push({ sourceId: source.id, reason: 'url-not-searchable' })
            continue
          }
        } catch {
          skipped.push({ sourceId: source.id, reason: 'unreadable' })
          continue
        }

        const bounded = body.length > maxBytes ? body.slice(0, maxBytes) : body
        const lines = bounded.split(/\r?\n/)
        let perSource = 0
        for (let index = 0; index < lines.length && perSource < maxHits; index += 1) {
          const line = lines[index] ?? ''
          if (!line.toLowerCase().includes(needle)) continue
          if (line.trim().length === 0) continue
          const locator: KnowledgeLexicalHit['locator'] =
            source.kind === 'file'
              ? {
                  kind: 'file',
                  path: source.location,
                  startLine: index + 1,
                  endLine: index + 1
                }
              : { kind: 'url', url: source.finalUrl ?? source.location }
          hits.push({ sourceId: source.id, label: source.label, text: line, locator })
          perSource += 1
        }
      }

      return {
        hits,
        // `pending` is what we could not read (plus what this build cannot search). The store's own
        // definition of "not indexed yet" is the same idea, so the two numbers agree in meaning.
        coverage: { indexed: examined.length - skipped.length, pending: skipped.length }
      }
    }
  }

  return { port, lastSkipped: () => skipped }
}
