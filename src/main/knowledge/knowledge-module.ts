// The knowledge module: the first composition that makes the store, the lexical port and the search
// service reachable from outside their own folder (v2.6.0 A1-wire).
//
// What it deliberately does NOT do: reach for a database, invent a second index, or hold text in
// memory between calls. The store's snapshot is the only state; text is read when a query runs.

import { readFile } from 'node:fs/promises'

import type {
  KnowledgeOverview,
  KnowledgeRegistration,
  KnowledgeSearchResponse,
  KnowledgeSource
} from '../../shared/knowledge'
import { createKnowledgeLexicalPort } from './knowledge-lexical-port'
import { KnowledgeRepository, type KnowledgeUrlReader } from './knowledge-repository'
import {
  createKnowledgeSearchService,
  type KnowledgeSemanticPort
} from './knowledge-search-service'
import type { KnowledgeCitationVerifier } from './knowledge-citation'

export type KnowledgeModuleOptions = {
  /** The data root; the store's snapshot lives at `<root>/knowledge/sources.json`. */
  root: string
  /** The managed roots a local path must sit inside. */
  roots: string[]
  /** How a URL source is fetched — the same reader registration uses, so both see one body. */
  urlReader?: KnowledgeUrlReader
  /** Absent until an embedding source is configured; the response says which it was. */
  semantic?: KnowledgeSemanticPort
  /** Absent means nobody re-reads the bytes; the response says `not-configured` rather than "fresh". */
  verifier?: KnowledgeCitationVerifier
  now?: () => number
  maxBytesPerSource?: number
  maxHitsPerSource?: number
  maxSources?: number
}

export type KnowledgeModule = {
  register(request: KnowledgeRegistration): Promise<KnowledgeSource[]>
  list(): Promise<KnowledgeSource[]>
  overview(): Promise<KnowledgeOverview>
  search(text: string, limit?: number): Promise<KnowledgeSearchResponse>
}

export const createKnowledgeModule = (options: KnowledgeModuleOptions): KnowledgeModule => {
  const repository = new KnowledgeRepository({
    root: options.root,
    roots: options.roots,
    ...(options.now ? { now: options.now } : {}),
    ...(options.urlReader ? { urlReader: options.urlReader } : {})
  })

  const lexical = createKnowledgeLexicalPort({
    listSources: () => repository.list(),
    readFileText: async (source) => readFile(source.location, 'utf8'),
    // A URL source is re-read through the same reader registration used, so a search sees the body a
    // registration fingerprinted rather than a second, differently-shaped fetch.
    ...(options.urlReader
      ? {
          readUrlText: async (source) =>
            (await options.urlReader!.read(source.finalUrl ?? source.location)).body
        }
      : {}),
    ...(options.maxBytesPerSource === undefined
      ? {}
      : { maxBytesPerSource: options.maxBytesPerSource }),
    ...(options.maxHitsPerSource === undefined
      ? {}
      : { maxHitsPerSource: options.maxHitsPerSource }),
    ...(options.maxSources === undefined ? {} : { maxSources: options.maxSources })
  })

  const search = createKnowledgeSearchService({
    lexical: lexical.port,
    ...(options.semantic ? { semantic: options.semantic } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {})
  })

  return {
    register: (request) => repository.register(request),
    list: () => repository.list(),
    overview: () => repository.overview(),
    search: (text, limit) => search.search(limit === undefined ? { text } : { text, limit })
  }
}
