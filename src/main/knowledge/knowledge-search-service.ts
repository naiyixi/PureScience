import { createHash } from 'node:crypto'

import type {
  KnowledgeCitation,
  KnowledgeCoverage,
  KnowledgeSearchDegradation,
  KnowledgeSearchMode,
  KnowledgeSearchResponse,
  KnowledgeSearchResult
} from '../../shared/knowledge'
import {
  fuseKnowledgeHits,
  knowledgeHitKey,
  type KnowledgeFusionRow
} from '../../shared/knowledge-fusion'
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

// A semantic source embeds the query and ranks the store's own chunks. It carries the text it matched for
// the same reason the lexical port does: the citation digest is recomputed here, from the bytes, so an
// embedding index can decide ORDER but never what the citation says.
export type KnowledgeSemanticHit = {
  sourceId: string
  label: string
  text: string
  locator: KnowledgeSearchResult['locator']
  score: number
}

export type KnowledgeSemanticPort = {
  query(text: string): Promise<{ hits: KnowledgeSemanticHit[]; model: string; dimensions: number }>
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
  // Absent means no embedding source is configured. Present but broken is a different answer: the
  // response then says `semantic-source-failed` instead of quietly reading like "this is all there is".
  semantic?: KnowledgeSemanticPort
}): {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse>
} => ({
  async search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
    const { hits, coverage } = await ports.lexical.query(request.text)

    const lexicalRows: KnowledgeFusionRow[] = hits.map((hit, index) => ({
      sourceId: hit.sourceId,
      label: hit.label,
      locator: hit.locator,
      lexicalRank: index
    }))
    // Text stays with the port that produced the row: the digest below is recomputed from those bytes,
    // so neither index can decide what a citation says — only which rows are worth citing.
    const textByKey = new Map<string, string>()
    for (const hit of hits) textByKey.set(knowledgeHitKey(hit.sourceId, hit.locator), hit.text)

    let semanticRows: KnowledgeFusionRow[] = []
    let mode: KnowledgeSearchMode = 'lexical'
    let degradation: KnowledgeSearchDegradation | undefined = 'semantic-source-unconfigured'
    if (ports.semantic) {
      try {
        const semantic = await ports.semantic.query(request.text)
        for (const hit of semantic.hits) {
          textByKey.set(knowledgeHitKey(hit.sourceId, hit.locator), hit.text)
        }
        semanticRows = semantic.hits.map((hit) => ({
          sourceId: hit.sourceId,
          label: hit.label,
          locator: hit.locator,
          semanticScore: hit.score
        }))
        mode = 'hybrid'
        // A source that ran and found nothing is reported as such — it is a different answer from a
        // source nobody configured, and only one of the two asks the reader to configure something.
        degradation = semanticRows.length > 0 ? undefined : 'semantic-source-empty'
      } catch {
        // Named, and the lexical answer is still returned. What must not happen is a lexical list
        // travelling under a hybrid label.
        mode = 'lexical'
        degradation = 'semantic-source-failed'
      }
    }

    const fused = fuseKnowledgeHits(lexicalRows, semanticRows, { limit: request.limit })
    const results: KnowledgeSearchResult[] = []
    for (const hit of fused.hits) {
      const text = textByKey.get(knowledgeHitKey(hit.sourceId, hit.locator)) ?? ''
      const sha256 = sha256Of(text)
      const citation: KnowledgeCitation = { sourceId: hit.sourceId, locator: hit.locator, sha256 }
      const verdict = ports.verifier ? await ports.verifier.verify(citation) : undefined
      results.push({
        sourceId: hit.sourceId,
        label: hit.label,
        locator: hit.locator,
        sha256,
        matchedBy: hit.matchedBy,
        score: hit.score,
        ...(mode === 'lexical' ? { lexicalOnly: true as const } : {}),
        // Marked ONLY when there is a verifier and it says the bytes moved. Never a default.
        ...(verdict?.state === 'stale' ? { stale: true as const } : {}),
        ...(verdict?.state === 'unreadable' ? { unreadable: true as const } : {})
      })
    }
    // The distinction the store exists to preserve: with matches, say so. Without matches, ask the index
    // whether it has everything — an empty answer from an index that still owes work is NOT "no matches".
    const status = results.length > 0 ? 'ok' : coverage.pending > 0 ? 'not-indexed' : 'no-matches'
    return {
      status,
      mode,
      ...(degradation ? { degradation } : {}),
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
