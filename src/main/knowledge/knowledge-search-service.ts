import { createHash } from 'node:crypto'

import type {
  KnowledgeCitation,
  KnowledgeCoverage,
  KnowledgeSearchResponse,
  KnowledgeSearchResult
} from '../../shared/knowledge'
import type { KnowledgeCitationVerifier } from './knowledge-citation'

// What a lexical hit carries: where it came from, and the exact text span the match sits in. The service
// below turns this into a citation by recomputing the digest of that text — the index is trusted for
// LOCATION, never for content, so a stale index cannot launder a wrong digest into a citation.
export type KnowledgeLexicalHit = {
  sourceId: string
  label: string
  // The text the match was found in. The service hashes exactly this.
  text: string
  locator: KnowledgeSearchResult['locator']
}

export type KnowledgeLexicalPort = {
  // Runs the query against the existing incremental index and reports what it has seen so far.
  query(text: string): Promise<{ hits: KnowledgeLexicalHit[]; coverage: KnowledgeCoverage }>
}

export type KnowledgeSearchRequest = {
  text: string
  limit?: number
}

// Lexical-only, by decision rather than by omission. The roadmap's semantic step needs an embedding source
// that this version does not have, and wiring a port nothing stands behind would let lexical hits travel
// under a name that promises more. So the response carries `mode: 'lexical'` and names the degradation on
// every call, and every row says `lexicalOnly` — nothing here can be mistaken for semantic retrieval.
export const createKnowledgeSearchService = (ports: {
  lexical: KnowledgeLexicalPort
  // Absent means nobody checked, which the response says outright. It does NOT mean fresh: a row that was
  // never re-checked must not wear the same face as one that was and still matched.
  verifier?: KnowledgeCitationVerifier
}): {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse>
} => ({
  async search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
    const { hits, coverage } = await ports.lexical.query(request.text)
    const limited = typeof request.limit === 'number' ? hits.slice(0, request.limit) : hits
    const results: KnowledgeSearchResult[] = []
    for (const hit of limited) {
      const sha256 = sha256Of(hit.text)
      const citation: KnowledgeCitation = { sourceId: hit.sourceId, locator: hit.locator, sha256 }
      const verdict = ports.verifier ? await ports.verifier.verify(citation) : undefined
      results.push({
        sourceId: hit.sourceId,
        label: hit.label,
        locator: hit.locator,
        sha256,
        lexicalOnly: true,
        // Marked ONLY when there is a verifier and it says the bytes moved. Never a default.
        ...(verdict?.state === 'stale' ? { stale: true } : {}),
        ...(verdict?.state === 'unreadable' ? { unreadable: true } : {})
      })
    }
    // The distinction the store exists to preserve: with matches, say so. Without matches, ask the index
    // whether it has everything — an empty answer from an index that still owes work is NOT "no matches".
    const status = results.length > 0 ? 'ok' : coverage.pending > 0 ? 'not-indexed' : 'no-matches'
    return {
      status,
      mode: 'lexical',
      degradation: 'semantic-source-unconfigured',
      verification: ports.verifier ? 'checked' : 'not-configured',
      coverage,
      results
    }
  }
})

export type KnowledgeSearchService = ReturnType<typeof createKnowledgeSearchService>

// The same digest the source store computes, so every path in the knowledge layer identifies content the
// same way — and here it is computed on the READ side, from the matched text itself.
const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
