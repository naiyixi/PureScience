// The four calls the knowledge MCP tools make, as the RPC surface expects them: same shape in the app and in the
// integration test, so a test can never pass by re-implementing the wrapper it is supposed to be exercising.
//
// Two things live here and nowhere else:
//   1. The NAMED refusal. The store throws `KnowledgeValidationError`, whose `code` is the part an agent can act on
//      (outside-the-roots vs. not-found vs. fetch-failed). Across the RPC transport only a message survives, so the
//      code is folded into it here instead of being lost.
//   2. The wiki call, which is a render over the current sources rather than a store operation.

import {
  KnowledgeValidationError,
  type KnowledgeCopySweep,
  type KnowledgeOverview,
  type KnowledgeRegistration,
  type KnowledgeSearchResponse,
  type KnowledgeSource
} from '../../shared/knowledge'
import type { KnowledgeModule } from './knowledge-module'
import type { KnowledgeWikiGenerator, KnowledgeWikiResult } from './knowledge-wiki'

export type KnowledgeRpcCalls = {
  search(request: { text: string; limit?: number }): Promise<KnowledgeSearchResponse>
  registerSource(request: KnowledgeRegistration): Promise<KnowledgeSource[]>
  listSources(): Promise<KnowledgeOverview>
  renderWiki(folder: string): Promise<KnowledgeWikiResult>
  removeSource(sourceId: string): Promise<{ removed: KnowledgeSource; prunedContents: string[] }>
  sweepCopies(): Promise<KnowledgeCopySweep>
}

const named = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    if (error instanceof KnowledgeValidationError) {
      throw new Error(`Knowledge source refused (${error.code}): ${error.message}`)
    }
    throw error
  }
}

export const createKnowledgeRpcCalls = (
  module: KnowledgeModule,
  wiki: KnowledgeWikiGenerator
): KnowledgeRpcCalls => ({
  search: (request) => named(() => module.search(request.text, request.limit)),
  registerSource: (request) => named(() => module.register(request)),
  listSources: () => named(() => module.overview()),
  renderWiki: async (folder) => named(async () => wiki.render(folder, await module.list())),
  removeSource: (sourceId) => named(() => module.remove(sourceId)),
  sweepCopies: () => named(() => module.sweepContents())
})
