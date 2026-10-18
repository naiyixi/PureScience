// The knowledge module: the first composition that makes the store, the lexical port and the search
// service reachable from outside their own folder (v2.6.0 A1-wire).
//
// What it deliberately does NOT do: reach for a database, invent a second index, or hold text in
// memory between calls. The store's snapshot is the only state; text is read when a query runs.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  /** Deletes stored copies no registered source references. Aborts on an unreadable register. */
  sweepContents(): Promise<{ scanned: number; pruned: string[] }>
  /** Removes a source and any copy only it referenced; reports what was pruned. */
  remove(sourceId: string): Promise<{ removed: KnowledgeSource; prunedContents: string[] }>
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
    // A URL source is searched against the copy taken at registration (named by its own digest). No network on
    // the query path: a search that needed one could not run offline, and re-fetching every page per query is a
    // crawl, not a search. A registration that predates the copy is healed ONCE here — fetched through the same
    // reader registration uses, and stored — so upgrading does not silently turn every existing URL source into
    // "unreadable". Verification is unaffected: it goes to the network on purpose.
    readUrlText: async (source) => {
      try {
        return await readFile(
          join(options.root, 'knowledge', 'contents', source.fingerprint.value),
          'utf8'
        )
      } catch {
        if (!options.urlReader) throw new Error('That URL source has no stored copy.')
        const read = await options.urlReader.read(source.finalUrl ?? source.location)
        try {
          await mkdir(join(options.root, 'knowledge', 'contents'), { recursive: true })
          await writeFile(
            join(options.root, 'knowledge', 'contents', source.fingerprint.value),
            read.body,
            'utf8'
          )
        } catch {
          // A copy that cannot be written still answers this query; the next one heals again.
        }
        return read.body
      }
    },
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
    remove: (sourceId) => repository.remove(sourceId),
    sweepContents: () => repository.sweepContents(),
    search: (text, limit) => search.search(limit === undefined ? { text } : { text, limit })
  }
}
