// The knowledge module: the first composition that makes the store, the lexical port and the search
// service reachable from outside their own folder (v2.6.0 A1-wire).
//
// What it deliberately does NOT do: reach for a database, invent a second index, or hold text in
// memory between calls. The store's snapshot is the only state; text is read when a query runs.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  KnowledgeCopySweep,
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

/**
 * Reads a stored copy only if its bytes still hash to the name it is filed under. A copy that no longer matches is
 * reported as MISSING, never as text: a search reads the file by that name and would otherwise cite bytes the
 * source's fingerprint never covered, with nothing on screen to say so. Missing is recoverable (the reader heals
 * it); wrong-but-served is not.
 */
const readVerifiedCopy = async (path: string, digest: string): Promise<string | undefined> => {
  let body: string
  try {
    body = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const actual = createHash('sha256').update(body, 'utf8').digest('hex')
  return actual === digest ? body : undefined
}

export type KnowledgeModule = {
  register(request: KnowledgeRegistration): Promise<KnowledgeSource[]>
  list(): Promise<KnowledgeSource[]>
  overview(): Promise<KnowledgeOverview>
  /** Deletes stored copies no registered source references. Aborts on an unreadable register. */
  sweepContents(): Promise<KnowledgeCopySweep>
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
    //
    // The copy is read through its own digest, not just its name: a file that was edited in place is not this
    // source's body any more, and answering with it would put text under a fingerprint that never covered it.
    readUrlText: async (source) => {
      const copyPath = join(options.root, 'knowledge', 'contents', source.fingerprint.value)
      const stored = await readVerifiedCopy(copyPath, source.fingerprint.value)
      if (stored !== undefined) return stored
      if (!options.urlReader) throw new Error('That URL source has no stored copy.')
      const read = await options.urlReader.read(source.finalUrl ?? source.location)
      const fetched = createHash('sha256').update(read.body, 'utf8').digest('hex')
      // Only bytes that hash to the name they would be filed under are written. Storing a body whose digest
      // differs would manufacture exactly the lying copy the sweep exists to delete — and it would overwrite the
      // name of a page that has since changed, which is a fact the source row cannot express either.
      if (fetched === source.fingerprint.value) {
        try {
          await mkdir(join(options.root, 'knowledge', 'contents'), { recursive: true })
          await writeFile(copyPath, read.body, 'utf8')
        } catch {
          // A copy that cannot be written still answers this query; the next one heals again.
        }
      }
      return read.body
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
