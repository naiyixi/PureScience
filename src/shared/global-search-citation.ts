import { formatGbt7714 } from './references'
import type { GlobalSearchHit } from './global-search'

// GB/T 7714 citation for a literature hit, built from the record the search returned.
//
// Deliberately narrow: only a literature hit that actually carries citation data produces a string.
// Anything else returns undefined rather than an empty or invented reference, so a "copy citation"
// action can be absent instead of copying a stub.

export const buildGlobalSearchHitCitation = (
  hit: Pick<GlobalSearchHit, 'scope' | 'title' | 'citation'>,
  options: { retrievedAt?: string } = {}
): string | undefined => {
  if (hit.scope !== 'literature' || !hit.citation) return undefined

  return formatGbt7714(
    {
      title: hit.title,
      authors: hit.citation.authors.map((name) => ({ name })),
      venue: hit.citation.venue,
      year: hit.citation.year,
      doi: hit.citation.doi,
      arxivId: hit.citation.arxivId,
      pmid: hit.citation.pmid,
      pmcid: hit.citation.pmcid
    },
    options
  )
}
