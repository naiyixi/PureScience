// Document-level translation: stored page text in, per-paragraph records out.
//
// The engine wiring lives in `run-translation.ts` (one runner, one refusal vocabulary, one place that makes
// the checkpoint store and the provider translator). This layer is the *document* half of that seam:
// segment the page text, name the document identity those paragraphs belong to, call the runner, then read
// the checkpoint back and answer per paragraph.
//
// The properties worth protecting here are the ones the tool surface promises: paragraph identity is stable
// across runs, an unchanged paragraph is never re-sent, a changed one is, a refused run leaves nothing on
// disk, and what a caller reads back is what the checkpoint store holds — never what the run merely
// produced.

import { mkdirSync, mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TranslationCheckpointStore } from './checkpoint-store'
import { runDocumentTranslation } from './document-translation'
import type { TranslationTargetLookup } from './run-translation'

let root: string

const pagesOf = (...texts: string[]): { page: number; text: string }[] =>
  texts.map((text, index) => ({ page: index + 1, text }))

const target = {
  url: 'https://api.deepseek.com/v1/chat/completions',
  key: 'k',
  model: 'deepseek-chat'
}

const usableTarget = (): TranslationTargetLookup => ({ ok: true, target })

// A stub that answers **per request** (`译:<asked text>`): an always-same answer would make "this paragraph
// was reused" unfalsifiable, because a reused paragraph and a re-translated one would carry identical text.
const makeFetch = (
  answer: (asked: string) => string = (asked) => `译:${asked}`
): ReturnType<typeof vi.fn> =>
  vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      model: string
      messages: { role: string; content: string }[]
    }
    const asked = body.messages.at(-1)?.content ?? ''
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: answer(asked) } }] })
    }
  })

/** A `vi.fn` is not a `fetch`: the cast is explicit because vitest does not type-check. */
const asFetch = (mock: ReturnType<typeof vi.fn>): typeof fetch => mock as unknown as typeof fetch

const failingFetch = (status: number, body: string): ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ status, ok: false, text: async () => body, json: async () => ({}) }))

const run = (
  pages: { page: number; text: string }[],
  fetchImpl: ReturnType<typeof vi.fn>,
  extra: {
    shouldStop?: () => boolean
    docId?: string
    target?: () => TranslationTargetLookup
  } = {}
): ReturnType<typeof runDocumentTranslation> =>
  runDocumentTranslation({
    docId: extra.docId ?? 'doc-1',
    documentPages: pages,
    storageRoot: root,
    targetLanguage: 'Simplified Chinese',
    target: extra.target ?? usableTarget,
    fetchImpl: asFetch(fetchImpl),
    ...(extra.shouldStop ? { shouldStop: extra.shouldStop } : {})
  })

const storePath = (docId = 'doc-1'): string =>
  new TranslationCheckpointStore({ root }).pathFor({ kind: 'pdf', id: docId })

/** The records as they are on disk — read by hand, with no help from the module under test. */
const recordsOnDisk = async (
  docId = 'doc-1'
): Promise<Record<string, { status: string; text?: string; reason?: string }>> => {
  const parsed = JSON.parse(await readFile(storePath(docId), 'utf8')) as {
    records: Record<string, { status: string; text?: string; reason?: string }>
  }
  return parsed.records
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ps-document-translation-'))
})

describe('document translation', () => {
  it('turns each page into paragraph records and answers with what the store holds', async () => {
    const fetchImpl = makeFetch()
    const outcome = await run(pagesOf('Alpha.\n\nBeta.', 'Gamma.'), fetchImpl)
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.detail}`)
    const result = outcome.result

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(result.docId).toBe('doc-1')
    expect(result.paragraphCount).toBe(3)
    expect(result.pages.map((page) => page.page)).toEqual([1, 2])
    expect(result.pages[0]?.paragraphs).toEqual([
      {
        id: 'p1#1',
        page: 1,
        paragraph: 1,
        status: 'translated',
        source: 'Alpha.',
        translation: '译:Alpha.'
      },
      {
        id: 'p1#2',
        page: 1,
        paragraph: 2,
        status: 'translated',
        source: 'Beta.',
        translation: '译:Beta.'
      }
    ])
    expect(result.pages[1]?.paragraphs.map((paragraph) => paragraph.id)).toEqual(['p2#1'])
    expect(result.restored).toEqual({ state: 'none', reason: 'no-checkpoint' })
    expect(result.stopped).toBeNull()
    // Every paragraph was accounted for by exactly one of these four buckets.
    expect(result.translated + result.reused + result.failed.length + result.skipped).toBe(3)

    // The answer is the store's, not the run's bookkeeping: the same file the report names holds these ids.
    expect(result.checkpointPath).toBe(storePath())
    const onDisk = await recordsOnDisk()
    expect(Object.keys(onDisk).sort()).toEqual(['p1#1', 'p1#2', 'p2#1'])
    for (const paragraph of result.pages.flatMap((page) => page.paragraphs)) {
      expect(paragraph.status).toBe(onDisk[paragraph.id]?.status)
    }
  })

  it('reuses everything a second run finds unchanged, and sends nothing again', async () => {
    const pages = pagesOf('Alpha.\n\nBeta.')
    await run(pages, makeFetch())

    // A different answer for the second run: if either paragraph came from the model again, its text would
    // read `译2:` and the reuse claim would fall apart.
    const second = makeFetch((asked) => `译2:${asked}`)
    const outcome = await run(pages, second)
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.detail}`)

    expect(second).not.toHaveBeenCalled()
    expect(outcome.result.reused).toBe(2)
    expect(outcome.result.translated).toBe(0)
    expect(outcome.result.failed).toEqual([])
    // "Partial" with a count, so a resumed run is distinguishable from a first run.
    expect(outcome.result.restored).toEqual({ state: 'partial', records: 2 })
    expect(outcome.result.pages[0]?.paragraphs[0]?.translation).toBe('译:Alpha.')
  })

  it('translates the document again when its own text changed, and says why it did not resume', async () => {
    await run(pagesOf('Alpha.\n\nBeta.'), makeFetch())

    const second = makeFetch((asked) => `译2:${asked}`)
    const outcome = await run(pagesOf('Alpha.\n\nBeta edited.'), second)
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.detail}`)

    // The checkpoint is keyed to the document's text, so an edited page is a change to the document: the run
    // does not mix translations of two different texts, and it names that reason instead of silently
    // reporting a fresh start.
    expect(second).toHaveBeenCalledTimes(2)
    expect(outcome.result.restored).toEqual({ state: 'none', reason: 'source-content-changed' })
    expect(outcome.result.translated).toBe(2)
    expect(outcome.result.reused).toBe(0)
    expect(outcome.result.pages[0]?.paragraphs[0]?.translation).toBe('译2:Alpha.')
  })

  it('keys a checkpoint to the document, so another document cannot reuse its paragraphs', async () => {
    await run(pagesOf('Alpha.\n\nBeta.'), makeFetch())

    const other = makeFetch()
    const outcome = await run(pagesOf('Alpha.\n\nBeta.'), other, { docId: 'doc-2' })
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.detail}`)

    expect(other).toHaveBeenCalledTimes(2)
    expect(outcome.result.reused).toBe(0)
    expect(outcome.result.restored).toEqual({ state: 'none', reason: 'no-checkpoint' })
  })

  it('names the paragraphs a stopped run never reached', async () => {
    const fetchImpl = makeFetch()
    let asked = 0
    const outcome = await run(pagesOf('A.\n\nB.\n\nC.'), fetchImpl, {
      // The engine asks before each paragraph: stopping on the second question means exactly one was done.
      shouldStop: () => asked++ >= 1
    })
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.detail}`)

    expect(outcome.result.stopped).toBe('requested')
    expect(outcome.result.skipped).toBe(2)
    expect(outcome.result.pages[0]?.paragraphs[0]).toMatchObject({
      id: 'p1#1',
      status: 'translated'
    })
    // An absent translation is reported with its own name, never as an empty string.
    expect(outcome.result.pages[0]?.paragraphs[1]).toMatchObject({
      id: 'p1#2',
      status: 'failed',
      reason: 'not-attempted'
    })
    expect(outcome.result.pages[0]?.paragraphs[2]).toMatchObject({
      id: 'p1#3',
      status: 'failed',
      reason: 'not-attempted'
    })
  })

  it('keeps a failed paragraph by name and re-sends it on the next run', async () => {
    const broken = failingFetch(500, 'model endpoint unavailable')
    const first = await run(pagesOf('Alpha.'), broken)
    if (!first.ok) throw new Error(`unreachable: ${first.detail}`)

    expect(first.result.failed).toEqual([
      { id: 'p1#1', reason: 'http-error (500): model endpoint unavailable' }
    ])
    expect(first.result.pages[0]?.paragraphs[0]).toMatchObject({
      status: 'failed',
      reason: 'http-error (500): model endpoint unavailable'
    })

    const retry = makeFetch(() => '译')
    const second = await run(pagesOf('Alpha.'), retry)
    if (!second.ok) throw new Error(`unreachable: ${second.detail}`)

    // A failure is not a translation: it goes back to the model instead of being skipped.
    expect(retry).toHaveBeenCalledTimes(1)
    expect(second.result.pages[0]?.paragraphs[0]).toMatchObject({
      status: 'translated',
      translation: '译'
    })
  })

  it('names pages with no text layer instead of returning paragraphs for them', async () => {
    const outcome = await run(pagesOf('Alpha.', ''), makeFetch())
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.detail}`)

    expect(outcome.result.emptyPages).toEqual([2])
    expect(outcome.result.pages.map((page) => page.page)).toEqual([1])
    expect(outcome.result.paragraphCount).toBe(1)
  })

  it('names a checkpoint that exists but could not be read, and translates the document again', async () => {
    // A half-written / corrupt checkpoint is not "nothing was translated yet": the run may start over, but it
    // has to say which way the file failed to load.
    mkdirSync(dirname(storePath()), { recursive: true })
    await writeFile(storePath(), '{not json', 'utf8')

    const fetchImpl = makeFetch()
    const outcome = await run(pagesOf('Alpha.'), fetchImpl)
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.detail}`)

    expect(outcome.result.restored).toEqual({
      state: 'none',
      reason: 'unreadable',
      detail: 'invalid-json'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(outcome.result.pages[0]?.paragraphs[0]).toMatchObject({ status: 'translated' })
  })

  it('refuses to start when no model endpoint is available, and leaves nothing on disk', async () => {
    const fetchImpl = makeFetch()
    const outcome = await run(pagesOf('Alpha.'), fetchImpl, {
      target: () => ({ ok: false, detail: 'No provider and model are configured for translation.' })
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reason).toBe('not-configured')
    expect(outcome.detail).toContain('No provider and model')
    expect(fetchImpl).not.toHaveBeenCalled()
    // A refusal must not leave an empty checkpoint behind: that would read as "already translated" later.
    await expect(readFile(storePath(), 'utf8')).rejects.toThrow()
  })

  it('refuses a document with nothing to translate, and leaves nothing on disk', async () => {
    const fetchImpl = makeFetch()
    // Every page empty = no text layer. That is not a translation of 0 paragraphs, and it is not recorded.
    const outcome = await run(pagesOf('', ''), fetchImpl)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reason).toBe('empty-source')
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(readFile(storePath(), 'utf8')).rejects.toThrow()
  })
})
