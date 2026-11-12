// The shelf is a document from another machine, and this machine's network does not always answer: the packaged
// logs show `cases:marketplace` ending at exactly the read's own deadline (20,005–20,041 ms in twenty rows), which
// is a reader waiting on a spinner, not a slow handler. The index itself is small — the published one is 739 bytes
// — so the cost of that wait buys nothing when the host is unreachable.
//
// So a successful read is kept on this machine, and the next launch answers from it instead of asking the network.
// Two rules keep that honest rather than merely fast:
//
//   1. Every answer says where it came from (`source`) and when the bytes were fetched (`fetchedAt`), as required
//      fields. A renderer cannot render a saved copy as a live one by omission, because there is no default.
//   2. The saved document is data from another machine — it is re-validated with the same validator the network
//      read uses, and a copy that fails is deleted rather than shown.
//
// An explicit `indexUrl` never touches the cache: the window names a document, and one window's address must not
// become this machine's saved shelf.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  CASE_MARKETPLACE_INDEX_URL,
  validateCaseMarketplaceIndex,
  type CaseMarketplaceIndex
} from '../../shared/case-marketplace'
import type { CaseMarketplaceRequest } from '../../shared/case-bundle'

import { fetchCaseMarketplaceIndex, type CaseMarketplaceFetchResult } from './marketplace'

export const CASE_MARKETPLACE_CACHE_FILENAME = 'marketplace-index.json'

export type CaseMarketplaceCachedIndex = { index: CaseMarketplaceIndex; fetchedAt: number }

/**
 * What one shelf read answered. `source` and `fetchedAt` are not optional: "we have a list" is not the whole answer,
 * and a caller that needs to say "this is the saved copy" must not be able to forget to.
 */
export type CaseMarketplaceRead =
  | { ok: true; index: CaseMarketplaceIndex; source: 'network' | 'cache'; fetchedAt: number }
  | {
      ok: false
      problem: 'unreachable' | 'bad-response' | 'too-large' | 'bad-index'
      detail?: string
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The saved index, or null when there is none this machine can stand behind. Every failure — missing file, unparsable
 * text, a document that no longer passes the validator — reads as "no saved copy" and, when a file was there, removes
 * it: a copy we would refuse to show is not worth keeping around to fail again next launch.
 */
export const readCaseMarketplaceCache = async (
  file: string
): Promise<CaseMarketplaceCachedIndex | null> => {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const discard = async (): Promise<null> => {
    try {
      await rm(file, { force: true })
    } catch {
      // A copy we cannot remove is still a copy we will not show.
    }
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return discard()
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.fetchedAt !== 'number' ||
    !Number.isFinite(parsed.fetchedAt)
  ) {
    return discard()
  }
  const validated = validateCaseMarketplaceIndex(parsed.index)
  if (!validated.ok) return discard()
  return { index: validated.index, fetchedAt: parsed.fetchedAt }
}

/**
 * Best-effort: a shelf that could not be saved must not turn a successful read into a failed one. Written through a
 * temporary sibling and one rename, so a reader never sees a half-written document.
 */
export const writeCaseMarketplaceCache = async (
  file: string,
  index: CaseMarketplaceIndex,
  fetchedAt: number
): Promise<void> => {
  const temporary = `${file}.tmp-${process.pid}`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, JSON.stringify({ fetchedAt, index }), 'utf8')
    await rename(temporary, file)
  } catch {
    try {
      await rm(temporary, { force: true })
    } catch {
      // Nothing else to do: the read itself already succeeded.
    }
  }
}

export type CaseMarketplaceIndexFetcher = (url: string) => Promise<CaseMarketplaceFetchResult>

/**
 * The one place the shelf decision lives, so it can be tested without a window: saved copy first, network only when
 * asked (`refresh`) or when there is nothing saved, and the saved copy as the answer when the network refuses.
 */
export const createCaseMarketplaceReader = (options: {
  cacheFile: string
  fetchIndex?: CaseMarketplaceIndexFetcher
  now?: () => number
}): ((request: CaseMarketplaceRequest) => Promise<CaseMarketplaceRead>) => {
  const fetchIndex = options.fetchIndex ?? fetchCaseMarketplaceIndex
  const now = options.now ?? Date.now
  return async (request) => {
    const explicit = request.indexUrl
    if (explicit !== undefined) {
      // The window named a document. Nothing about it is saved: the address it chose is not this machine's shelf.
      const read = await fetchIndex(explicit)
      return read.ok ? { ok: true, index: read.index, source: 'network', fetchedAt: now() } : read
    }
    if (request.refresh !== true) {
      const saved = await readCaseMarketplaceCache(options.cacheFile)
      if (saved)
        return { ok: true, index: saved.index, source: 'cache', fetchedAt: saved.fetchedAt }
    }
    const read = await fetchIndex(CASE_MARKETPLACE_INDEX_URL)
    if (read.ok) {
      const fetchedAt = now()
      await writeCaseMarketplaceCache(options.cacheFile, read.index, fetchedAt)
      return { ok: true, index: read.index, source: 'network', fetchedAt }
    }
    // The refresh the reader asked for failed. A saved list is a better answer than an error beside an empty shelf —
    // and it says when it was fetched, so it does not pretend to be this attempt's result.
    const saved = await readCaseMarketplaceCache(options.cacheFile)
    if (saved) return { ok: true, index: saved.index, source: 'cache', fetchedAt: saved.fetchedAt }
    return read
  }
}
