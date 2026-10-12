// Checkpoint store tests: round-trip, the three named read failures, record-level sanitizing (a half-written
// record is dropped and named rather than repaired into something that looks reusable), and the identity check
// that decides whether stored records may be believed at all.

import { mkdtempSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import type { TranslationRecord } from '../../shared/translation-units'

import {
  TRANSLATION_CHECKPOINT_DIR,
  TranslationCheckpointStore,
  checkpointAppliesTo,
  translationSourceContentHash,
  type TranslationSourceIdentity
} from './checkpoint-store'

let root: string
let store: TranslationCheckpointStore

const source = (overrides: Partial<TranslationSourceIdentity> = {}): TranslationSourceIdentity => ({
  kind: 'pdf',
  id: 'doc-1',
  contentHash: translationSourceContentHash(['page one', 'page two']),
  ...overrides
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ps-translation-'))
  store = new TranslationCheckpointStore({ root })
})

const record = (overrides: Partial<TranslationRecord> = {}): TranslationRecord => ({
  id: 'p1#1',
  page: 1,
  sourceHash: 'hash-1',
  status: 'translated',
  text: '甲。',
  updatedAt: 10,
  ...overrides
})

describe('translation checkpoint store', () => {
  it('reads absent for a document that was never translated', async () => {
    expect(await store.read(source())).toEqual({ state: 'absent' })
  })

  it('round-trips records and keeps the document identity', async () => {
    await store.write(source(), { 'p1#1': record() })
    const loaded = await store.read(source())
    expect(loaded.state).toEqual('ok')
    if (loaded.state !== 'ok') return
    expect(loaded.checkpoint.records['p1#1']).toEqual({
      id: 'p1#1',
      page: 1,
      sourceHash: 'hash-1',
      status: 'translated',
      text: '甲。',
      updatedAt: 10
    })
    expect(loaded.checkpoint.source).toEqual(source())
    expect(loaded.droppedRecordIds).toEqual([])
  })

  it('writes the checkpoint under the store root, leaving no temp file behind', async () => {
    await store.write(source(), {})
    const files = await readdir(join(root, TRANSLATION_CHECKPOINT_DIR))
    expect(files.length).toEqual(1)
    expect(files[0]?.endsWith('.json')).toEqual(true)
    expect(files.some((file) => file.endsWith('.tmp'))).toEqual(false)
  })

  it('derives the file name from the identity, so an id cannot address a path outside the root', async () => {
    const escaping = store.pathFor({ kind: 'pdf', id: '../../etc/passwd' })
    expect(escaping.startsWith(join(root, TRANSLATION_CHECKPOINT_DIR))).toEqual(true)
    expect(escaping.includes('..')).toEqual(false)
    expect(store.pathFor({ kind: 'pdf', id: 'doc-1' })).toEqual(
      store.pathFor({ kind: 'pdf', id: 'doc-1' })
    )
    expect(store.pathFor({ kind: 'pdf', id: 'doc-1' })).not.toEqual(
      store.pathFor({ kind: 'docx', id: 'doc-1' })
    )
  })

  it('names each way the file can fail instead of returning an empty record set', async () => {
    await store.write(source(), {})
    const path = store.pathFor(source())

    await writeFile(path, 'not json at all', 'utf8')
    expect(await store.read(source())).toEqual({ state: 'unreadable', reason: 'invalid-json' })

    await writeFile(path, JSON.stringify({ version: 99, source: source(), records: {} }), 'utf8')
    expect(await store.read(source())).toEqual({ state: 'unreadable', reason: 'wrong-version' })

    await writeFile(path, JSON.stringify(['array']), 'utf8')
    expect(await store.read(source())).toEqual({ state: 'unreadable', reason: 'invalid-shape' })

    await writeFile(
      path,
      JSON.stringify({ version: 1, source: { kind: 'pdf' }, records: {} }),
      'utf8'
    )
    expect(await store.read(source())).toEqual({ state: 'unreadable', reason: 'invalid-shape' })
  })

  it('drops records whose fields a resume decision needs, and reports which', async () => {
    const path = store.pathFor(source())
    await store.write(source(), {})
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    written.records = {
      'p1#1': record(),
      'p1#2': { ...record(), sourceHash: '' },
      'p1#3': { ...record(), text: '' },
      'p1#4': { ...record(), status: 'maybe' },
      'p1#5': { ...record(), status: 'failed', text: undefined, reason: 'timeout' }
    }
    await writeFile(path, JSON.stringify(written), 'utf8')

    const loaded = await store.read(source())
    expect(loaded.state).toEqual('ok')
    if (loaded.state !== 'ok') return
    expect(Object.keys(loaded.checkpoint.records).sort()).toEqual(['p1#1', 'p1#5'])
    expect(loaded.droppedRecordIds).toEqual(['p1#2', 'p1#3', 'p1#4'])
    // A failed record keeps its name, so the retry knows what happened last time.
    expect(loaded.checkpoint.records['p1#5']?.reason).toEqual('timeout')
  })

  it('does not repair a translated record that has no text into a reusable one', async () => {
    const path = store.pathFor(source())
    await store.write(source(), {})
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    written.records = { 'p1#1': { id: 'p1#1', page: 1, sourceHash: 'h', status: 'translated' } }
    await writeFile(path, JSON.stringify(written), 'utf8')
    const loaded = await store.read(source())
    expect(loaded.state === 'ok' && Object.keys(loaded.checkpoint.records).length).toEqual(0)
  })

  it('decides applicability by document first, then by content', () => {
    const checkpoint = { source: source() }
    expect(checkpointAppliesTo(checkpoint, source())).toEqual({ applies: true })
    expect(checkpointAppliesTo(checkpoint, source({ kind: 'docx' }))).toEqual({
      applies: false,
      reason: 'source-document-changed'
    })
    expect(checkpointAppliesTo(checkpoint, source({ id: 'doc-2' }))).toEqual({
      applies: false,
      reason: 'source-document-changed'
    })
    expect(
      checkpointAppliesTo(
        checkpoint,
        source({ contentHash: translationSourceContentHash(['edited']) })
      )
    ).toEqual({ applies: false, reason: 'source-content-changed' })
  })

  it('fingerprints page content in order, including page boundaries', () => {
    expect(translationSourceContentHash(['ab', 'c'])).not.toEqual(
      translationSourceContentHash(['a', 'bc'])
    )
    expect(translationSourceContentHash(['one', 'two'])).not.toEqual(
      translationSourceContentHash(['two', 'one'])
    )
    expect(translationSourceContentHash(['one', 'two'])).toEqual(
      translationSourceContentHash(['one', 'two'])
    )
    // A page that lost its text layer is a different document than one that had text.
    expect(translationSourceContentHash(['text', ''])).not.toEqual(
      translationSourceContentHash(['text'])
    )
  })
})
