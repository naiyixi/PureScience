import { createHash } from 'node:crypto'

import type { KnowledgeCitation, KnowledgeLocator } from '../../shared/knowledge'

// Where the current bytes of a cited location come from. The verifier never asks the index: an index is a
// snapshot, and the whole point of re-checking is to find out whether the bytes moved since.
export type KnowledgeContentReader = {
  // Returns the text sitting at that location now, or undefined when it cannot be read at all.
  read(locator: KnowledgeLocator): Promise<string | undefined>
}

// Three states, not two. "The bytes changed" and "I could not look" are different findings: the first says
// the citation is out of date, the second says nothing about the citation at all, and treating the second
// as the first would quietly retire citations nobody actually disproved.
export type KnowledgeCitationState = 'fresh' | 'stale' | 'unreadable'

export type KnowledgeCitationVerdict = {
  state: KnowledgeCitationState
  // The digest of what is there NOW — computed here, never taken from the citation or an index.
  sha256?: string
}

export const sha256Of = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

export const createKnowledgeCitationVerifier = (ports: {
  reader: KnowledgeContentReader
}): {
  verify(citation: KnowledgeCitation): Promise<KnowledgeCitationVerdict>
} => ({
  async verify(citation: KnowledgeCitation): Promise<KnowledgeCitationVerdict> {
    const current = await ports.reader.read(citation.locator)
    if (current === undefined) return { state: 'unreadable' }
    const digest = sha256Of(current)
    return { state: digest === citation.sha256 ? 'fresh' : 'stale', sha256: digest }
  }
})

export type KnowledgeCitationVerifier = ReturnType<typeof createKnowledgeCitationVerifier>
