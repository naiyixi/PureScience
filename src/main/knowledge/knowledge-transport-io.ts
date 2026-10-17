// The two pieces of real-world IO the knowledge layer asks for, kept out of the store and out of the RPC surface:
//
//   * `createKnowledgeUrlReader` — how a URL source is fetched (bounded, named failures). The repository takes it
//     for registration; the search path takes it for URL bodies.
//   * `createKnowledgeContentReader` — how a CITATION is re-read. This is the verifier's only view of the world,
//     and it deliberately re-reads rather than consulting any stored copy: a cache that answers the verifier
//     agrees with itself and can never say "stale".

import { readFile } from 'node:fs/promises'

import type { KnowledgeLocator } from '../../shared/knowledge'
import type { KnowledgeContentReader } from './knowledge-citation'
import type { KnowledgeUrlReader } from './knowledge-repository'

export type KnowledgeUrlRead = { body: string; finalUrl: string }

/** A fetch that names its refusals: bad status, too large, timed out — each reported, never truncated silently. */
export const createKnowledgeUrlReader = (
  options: {
    fetch?: typeof globalThis.fetch
    maxBytes?: number
    timeoutMs?: number
  } = {}
): KnowledgeUrlReader => {
  const fetchImpl = options.fetch ?? globalThis.fetch
  // 8 MB: a source is text we hash and search, not a download manager. Anything larger is refused by name
  // rather than truncated, because a silently truncated body would fingerprint as if it were the whole page.
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 20_000

  return {
    async read(url: string): Promise<KnowledgeUrlRead> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1' }
        })
        if (!response.ok) throw new Error(`That URL answered ${response.status}.`)
        const declared = Number(response.headers.get('content-length') ?? Number.NaN)
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new Error(`That URL is ${declared} bytes, larger than the ${maxBytes}-byte limit.`)
        }
        const body = await response.text()
        const bytes = Buffer.byteLength(body, 'utf8')
        if (bytes > maxBytes) {
          throw new Error(`That URL is ${bytes} bytes, larger than the ${maxBytes}-byte limit.`)
        }
        return { body, finalUrl: response.url || url }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

const readLocalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** The verification path: read the location the citation names, as it is now. */
export const createKnowledgeContentReader = (
  options: {
    readFile?: (path: string) => Promise<string | undefined>
    urlReader?: KnowledgeUrlReader
  } = {}
): KnowledgeContentReader => {
  const readFileImpl = options.readFile ?? readLocalText

  return {
    async read(locator: KnowledgeLocator): Promise<string | undefined> {
      if (locator.kind === 'url') {
        if (!options.urlReader) return undefined
        try {
          return (await options.urlReader.read(locator.url)).body
        } catch {
          return undefined
        }
      }
      if (locator.kind === 'file') {
        const body = await readFileImpl(locator.path)
        if (body === undefined) return undefined
        const lines = body.split('\n')
        if (locator.startLine < 1 || locator.endLine < locator.startLine) return undefined
        if (locator.startLine > lines.length) return undefined
        return lines.slice(locator.startLine - 1, locator.endLine).join('\n')
      }
      // This store never registers PDFs, so a pdf locator can only arrive from outside it. Reported as unreadable
      // rather than hashed against something that is not what the citation points at.
      return undefined
    }
  }
}
