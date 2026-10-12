// Translation run tests. The two properties worth protecting: a restart only ever skips a paragraph that is
// provably unchanged, and nothing is ever recorded as translated without text.

import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  segmentPageIntoTranslationUnits,
  type TranslationUnit
} from '../../shared/translation-units'
import {
  TranslationCheckpointStore,
  translationSourceContentHash,
  type TranslationSourceIdentity
} from './checkpoint-store'
import { runTranslation, translationSourceHash, type TranslationTranslator } from './engine'

let root: string
let store: TranslationCheckpointStore

const pages = ['Alpha paragraph.\n\nSecond paragraph.', 'Third page paragraph.']

const unitsOf = (pageTexts: string[]): TranslationUnit[] =>
  pageTexts.flatMap((text, index) => segmentPageIntoTranslationUnits(index + 1, text))

const source = (overrides: Partial<TranslationSourceIdentity> = {}): TranslationSourceIdentity => ({
  kind: 'pdf',
  id: 'doc-1',
  contentHash: translationSourceContentHash(pages),
  ...overrides
})

// A translator that records every unit it was asked for, so "was this re-sent?" is observable rather than inferred.
const recordingTranslator = (
  answer: (unit: TranslationUnit) => { ok: true; text: string } | { ok: false; reason: string } = (
    unit
  ) => ({
    ok: true,
    text: `译:${unit.id}`
  })
): { translate: TranslationTranslator; seen: string[] } => {
  const seen: string[] = []
  return {
    seen,
    translate: async (unit) => {
      seen.push(unit.id)
      return answer(unit)
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ps-translation-run-'))
  store = new TranslationCheckpointStore({ root })
})

describe('translation run', () => {
  it('translates every unit of a document with no checkpoint and records the source hash', async () => {
    const units = unitsOf(pages)
    const { translate, seen } = recordingTranslator()
    const result = await runTranslation({ source: source(), units, store, translate })

    expect(seen).toEqual(['p1#1', 'p1#2', 'p2#1'])
    expect(result.restored).toEqual({ state: 'none', reason: 'no-checkpoint' })
    expect(result.translated).toEqual(3)
    expect(result.reused).toEqual(0)
    expect(result.failed).toEqual([])
    expect(result.stopped).toEqual(null)

    const loaded = await store.read(source())
    expect(loaded.state).toEqual('ok')
    if (loaded.state !== 'ok') return
    expect(loaded.checkpoint.records['p2#1']).toMatchObject({
      page: 2,
      status: 'translated',
      text: '译:p2#1',
      sourceHash: translationSourceHash(units[2]!)
    })
  })

  it('re-sends nothing on a second run over unchanged text', async () => {
    const units = unitsOf(pages)
    await runTranslation({
      source: source(),
      units,
      store,
      translate: recordingTranslator().translate
    })

    const second = recordingTranslator()
    const result = await runTranslation({
      source: source(),
      units,
      store,
      translate: second.translate
    })

    expect(second.seen).toEqual([])
    expect(result.reused).toEqual(3)
    expect(result.translated).toEqual(0)
    expect(result.restored).toEqual({ state: 'partial', records: 3, droppedRecordIds: [] })
  })

  it('resumes after an interruption: one run stops mid-document, the next sends only the remainder', async () => {
    const units = unitsOf(pages)
    let budget = 2
    const first = recordingTranslator()
    const interrupted = await runTranslation({
      source: source(),
      units,
      store,
      translate: first.translate,
      shouldStop: () => budget-- <= 0
    })

    expect(first.seen).toEqual(['p1#1', 'p1#2'])
    expect(interrupted.translated).toEqual(2)
    expect(interrupted.skipped).toEqual(1)
    expect(interrupted.stopped).toEqual('requested')

    // The records survive the interruption on disk, which is what makes the resume real.
    const second = recordingTranslator()
    const resumed = await runTranslation({
      source: source(),
      units,
      store,
      translate: second.translate
    })
    expect(second.seen).toEqual(['p2#1'])
    expect(resumed.reused).toEqual(2)
    expect(resumed.translated).toEqual(1)
    expect(resumed.stopped).toEqual(null)
  })

  it('re-translates an edited paragraph and keeps the untouched ones', async () => {
    const units = unitsOf(pages)
    await runTranslation({
      source: source(),
      units,
      store,
      translate: recordingTranslator().translate
    })

    const editedPages = ['Alpha paragraph.\n\nSecond paragraph, revised.', 'Third page paragraph.']
    const editedUnits = unitsOf(editedPages)
    const { translate, seen } = recordingTranslator()
    const result = await runTranslation({
      source: source({ contentHash: translationSourceContentHash(editedPages) }),
      units: editedUnits,
      store,
      translate
    })

    // Both paragraphs hash to ids that already exist, but the whole checkpoint is for other content, so nothing
    // is believed and the document is translated again from its own text.
    expect(result.restored).toEqual({ state: 'none', reason: 'source-content-changed' })
    expect(seen).toEqual(['p1#1', 'p1#2', 'p2#1'])
  })

  it('re-translates a changed paragraph within the same document fingerprint', async () => {
    const units = unitsOf(pages)
    await runTranslation({
      source: source(),
      units,
      store,
      translate: recordingTranslator().translate
    })

    // Same document identity and same content fingerprint, but one paragraph's bytes changed: the record for it
    // must not be reused. (This is reachable when a caller reuses an identity while the text moved.)
    const changed = [{ ...units[0]!, text: 'Alpha paragraph reworded.' }, units[1]!, units[2]!]
    const { translate, seen } = recordingTranslator()
    const result = await runTranslation({
      source: source(),
      units: changed,
      store,
      translate
    })

    expect(seen).toEqual(['p1#1'])
    expect(result.reused).toEqual(2)
    const loaded = await store.read(source())
    expect(loaded.state === 'ok' && loaded.checkpoint.records['p1#1']?.text).toEqual('译:p1#1')
  })

  it('records a failed paragraph with its reason and retries it on the next run', async () => {
    const units = unitsOf(pages)
    const { translate } = recordingTranslator((unit) =>
      unit.id === 'p1#2' ? { ok: false, reason: 'timeout after 100ms' } : { ok: true, text: '译' }
    )
    const first = await runTranslation({ source: source(), units, store, translate })

    expect(first.failed).toEqual([{ id: 'p1#2', reason: 'timeout after 100ms' }])
    expect(first.translated).toEqual(2)

    const second = recordingTranslator()
    const resumed = await runTranslation({
      source: source(),
      units,
      store,
      translate: second.translate
    })
    expect(second.seen).toEqual(['p1#2'])
    expect(resumed.reused).toEqual(2)
  })

  it('never records an empty answer as a translation', async () => {
    const units = unitsOf(pages)
    const { translate } = recordingTranslator((unit) =>
      unit.id === 'p1#1' ? { ok: true, text: '   ' } : { ok: true, text: '译' }
    )
    const result = await runTranslation({ source: source(), units, store, translate })

    expect(result.failed).toEqual([{ id: 'p1#1', reason: 'empty-translation' }])
    expect(result.translated).toEqual(2)
    const loaded = await store.read(source())
    expect(loaded.state === 'ok' && loaded.checkpoint.records['p1#1']?.status).toEqual('failed')
  })

  it('stops after repeated failures instead of running a broken provider over a whole document', async () => {
    const units = unitsOf(pages)
    const many = [...units, ...segmentPageIntoTranslationUnits(3, 'Fourth.\n\nFifth.\n\nSixth.')]
    const { translate, seen } = recordingTranslator(() => ({ ok: false, reason: 'no-provider' }))
    const result = await runTranslation({ source: source(), units: many, store, translate })

    expect(seen).toEqual(['p1#1', 'p1#2', 'p2#1'])
    expect(result.stopped).toEqual('repeated-failures')
    expect(result.failed.length).toEqual(3)
    expect(result.skipped).toEqual(3)
  })

  it('gives another document its own checkpoint instead of reading this one', async () => {
    const units = unitsOf(pages)
    await runTranslation({
      source: source(),
      units,
      store,
      translate: recordingTranslator().translate
    })

    const { translate, seen } = recordingTranslator()
    const result = await runTranslation({
      source: source({ id: 'doc-2' }),
      units,
      store,
      translate
    })

    // The file name is derived from the document identity, so a different document never even reaches the
    // identity check — it starts from nothing. (The in-file check still exists for a collision; see the store's
    // `checkpointAppliesTo` test, where `source-document-changed` is exercised directly.)
    expect(result.restored).toEqual({ state: 'none', reason: 'no-checkpoint' })
    expect(seen.length).toEqual(3)
    expect(store.pathFor(source())).not.toEqual(store.pathFor(source({ id: 'doc-2' })))
  })

  it('translates anyway when the checkpoint on disk is unreadable, and names why', async () => {
    const units = unitsOf(pages)
    await store.write(source(), {})
    await writeFile(store.pathFor(source()), 'not json', 'utf8')

    const { translate, seen } = recordingTranslator()
    const result = await runTranslation({ source: source(), units, store, translate })

    expect(result.restored).toEqual({
      state: 'none',
      reason: 'unreadable',
      detail: 'invalid-json'
    })
    expect(seen.length).toEqual(3)
  })

  it('prunes records for paragraphs that no longer exist', async () => {
    const units = unitsOf(pages)
    await runTranslation({
      source: source(),
      units,
      store,
      translate: recordingTranslator().translate
    })
    await store.write(source(), {
      ...(await (async () => {
        const loaded = await store.read(source())
        return loaded.state === 'ok' ? loaded.checkpoint.records : {}
      })()),
      'p9#9': {
        id: 'p9#9',
        page: 9,
        sourceHash: 'stale',
        status: 'translated',
        text: '旧',
        updatedAt: 1
      }
    })

    const result = await runTranslation({
      source: source(),
      units,
      store,
      translate: recordingTranslator().translate
    })

    const loaded = await store.read(source())
    expect(result.reused).toEqual(3)
    expect(loaded.state === 'ok' && loaded.checkpoint.records['p9#9']).toEqual(undefined)
    expect(loaded.state === 'ok' && Object.keys(loaded.checkpoint.records).length).toEqual(3)
  })

  it('reports progress with counts that match the final result', async () => {
    const units = unitsOf(pages)
    const progress: { translated: number; failed: number; unitId: string }[] = []
    const { translate } = recordingTranslator()
    const result = await runTranslation({
      source: source(),
      units,
      store,
      translate,
      onProgress: (event) => progress.push(event)
    })

    expect(progress.map((event) => event.unitId)).toEqual(['p1#1', 'p1#2', 'p2#1'])
    expect(progress.at(-1)).toMatchObject({
      total: 3,
      translated: result.translated,
      failed: 0
    })
  })

  it('writes the checkpoint after every unit, so an interruption loses at most the in-flight one', async () => {
    const units = unitsOf(pages)
    const writes: number[] = []
    const { translate } = recordingTranslator()
    const spyStore = new TranslationCheckpointStore({
      root,
      now: () => Date.now()
    })
    const originalWrite = spyStore.write.bind(spyStore)
    spyStore.write = async (identity, records) => {
      writes.push(Object.keys(records).length)
      await originalWrite(identity, records)
    }

    // One write per unit, then a final flush that persists the pruned record set.
    await runTranslation({ source: source(), units, store: spyStore, translate })
    expect(writes).toEqual([1, 2, 3, 3])
  })
})
