import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  TOOL_CALL_READINGS_RECIPE,
  compareToolCallReadings,
  parseToolCallReadingsDocument,
  type SessionPackageToolReadings,
  type ToolCallReadingsDocument
} from './tool-call-readings'

// 这一份测试故意**不**调被测模块的摘要助手：配方是发布给第三方的文字，第三方只有字节能拿。
// 所以这里按文字重新实现一遍（第 2 步：对包里那份文件的原始字节做 sha256），再拿结果去比。
const thirdPartyDigest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

const encoder = new TextEncoder()

const document = (overrides: Partial<ToolCallReadingsDocument> = {}): ToolCallReadingsDocument => ({
  recipe: TOOL_CALL_READINGS_RECIPE,
  rows: [
    { turnId: 'a1', tool: 'notebook_state', durationMs: 12 },
    { turnId: 'a2', tool: 'notebook_execute', durationMs: 2400, resultBytes: 512 }
  ],
  unnamed: 1,
  ...overrides
})

const carried = (
  doc: ToolCallReadingsDocument | null,
  bytes?: Uint8Array
): { sha256: string | null; document: ToolCallReadingsDocument | null } => ({
  sha256: bytes ? thirdPartyDigest(bytes) : null,
  document: doc
})

const declaredFrom = (
  doc: ToolCallReadingsDocument,
  bytes: Uint8Array
): SessionPackageToolReadings => ({
  recipe: doc.recipe,
  state: 'included',
  rows: doc.rows.length,
  unnamed: doc.unnamed,
  sha256: thirdPartyDigest(bytes)
})

describe('parseToolCallReadingsDocument', () => {
  it('reads rows and the unnamed count out of the carried document', () => {
    expect(parseToolCallReadingsDocument(JSON.stringify(document()))).toEqual(document())
  })

  it('refuses a document it cannot trust rather than returning zero rows', () => {
    expect(parseToolCallReadingsDocument('{not json')).toBeNull()
    expect(parseToolCallReadingsDocument(JSON.stringify({ rows: [] }))).toBeNull()
    expect(parseToolCallReadingsDocument(JSON.stringify({ recipe: 'x', rows: 'nope' }))).toBeNull()
    // 一条读不出名字的行不能被当成「这一行没有名字」：整份文件读作不可信。
    expect(
      parseToolCallReadingsDocument(
        JSON.stringify({ recipe: TOOL_CALL_READINGS_RECIPE, rows: [{ turnId: 'a1' }], unnamed: 0 })
      )
    ).toBeNull()
    // 负数的「条数」不是条数。
    expect(
      parseToolCallReadingsDocument(
        JSON.stringify({ recipe: TOOL_CALL_READINGS_RECIPE, rows: [], unnamed: -1 })
      )
    ).toBeNull()
  })
})

describe('compareToolCallReadings', () => {
  it('matches when rows, unnamed count and the byte digest all agree', () => {
    const doc = document()
    const bytes = encoder.encode(JSON.stringify(doc, null, 2))
    expect(compareToolCallReadings(declaredFrom(doc, bytes), carried(doc, bytes))).toEqual({
      state: 'match',
      rows: 2,
      unnamed: 1
    })
  })

  it('binds the digest to the bytes that travelled, not to the parsed document', () => {
    // 同一份内容、不同空白 ⇒ 解析结果相同、字节不同。摘要若算在「重新序列化」上，这两种会被读成
    // 一致；按配方的做法（对原始字节做 sha256）它必须红。这条就是「对外可复算」的判据。
    const doc = document()
    const short = encoder.encode(JSON.stringify(doc))
    const pretty = encoder.encode(JSON.stringify(doc, null, 2))
    expect(parseToolCallReadingsDocument(new TextDecoder().decode(short))).toEqual(
      parseToolCallReadingsDocument(new TextDecoder().decode(pretty))
    )

    const declared = declaredFrom(doc, short)
    expect(compareToolCallReadings(declared, carried(doc, pretty))).toEqual({
      state: 'mismatch',
      fields: ['sha256']
    })
  })

  it('names every field that disagrees instead of a bare failure', () => {
    const doc = document()
    const bytes = encoder.encode(JSON.stringify(doc))
    // Narrowed first: spreading the union directly would widen the absent variants, which have no `rows`.
    const produced = declaredFrom(doc, bytes)
    if (produced.state !== 'included') throw new Error('expected an included declaration')
    const declared: SessionPackageToolReadings = { ...produced, rows: 7, unnamed: 0 }
    expect(compareToolCallReadings(declared, carried(doc, bytes))).toEqual({
      state: 'mismatch',
      fields: ['rows', 'unnamed']
    })
  })

  it('reports an absent declaration as not-recorded — never as agreement', () => {
    expect(compareToolCallReadings(undefined, { sha256: null, document: null })).toEqual({
      state: 'not-recorded'
    })
  })

  it('reports a declaration it cannot read as underivable', () => {
    const doc = document()
    const bytes = encoder.encode(JSON.stringify(doc))
    expect(compareToolCallReadings({ state: 'included' }, carried(doc, bytes))).toEqual({
      state: 'underivable',
      reason: 'declaration-unreadable'
    })
    expect(
      compareToolCallReadings({ ...declaredFrom(doc, bytes), state: 'weird' }, carried(doc, bytes))
    ).toEqual({
      state: 'underivable',
      reason: 'declaration-unreadable'
    })
  })

  it('separates "this session ran no tools" from "the exporter did not collect it"', () => {
    const none: SessionPackageToolReadings = {
      recipe: TOOL_CALL_READINGS_RECIPE,
      state: 'absent:no-tool-calls',
      unnamed: 0
    }
    const notCollected: SessionPackageToolReadings = {
      recipe: TOOL_CALL_READINGS_RECIPE,
      state: 'absent:not-collected'
    }
    expect(compareToolCallReadings(none, { sha256: null, document: null })).toEqual({
      state: 'match',
      rows: 0,
      unnamed: 0
    })
    expect(compareToolCallReadings(notCollected, { sha256: null, document: null })).toEqual({
      state: 'match',
      rows: 0,
      unnamed: 0
    })
  })

  it('refuses a package that carries readings its manifest calls absent', () => {
    const doc = document()
    const bytes = encoder.encode(JSON.stringify(doc))
    const absent: SessionPackageToolReadings = {
      recipe: TOOL_CALL_READINGS_RECIPE,
      state: 'absent:no-tool-calls',
      unnamed: 0
    }
    expect(compareToolCallReadings(absent, carried(doc, bytes))).toEqual({
      state: 'mismatch',
      fields: ['state']
    })
  })

  it('cannot verify a declaration whose file did not arrive, or whose recipe is not ours', () => {
    const doc = document()
    const bytes = encoder.encode(JSON.stringify(doc))
    const declared = declaredFrom(doc, bytes)
    expect(compareToolCallReadings(declared, { sha256: null, document: null })).toEqual({
      state: 'underivable',
      reason: 'file-missing'
    })
    const bytes2 = encoder.encode(JSON.stringify(doc))
    expect(
      compareToolCallReadings(declared, { sha256: thirdPartyDigest(bytes2), document: null })
    ).toEqual({
      state: 'underivable',
      reason: 'file-unparseable'
    })
    const foreign = { ...doc, recipe: 'something-else:v1' }
    const foreignBytes = encoder.encode(JSON.stringify(foreign))
    expect(
      compareToolCallReadings(declaredFrom(doc, foreignBytes), carried(foreign, foreignBytes))
    ).toEqual({ state: 'underivable', reason: 'recipe-unknown' })
  })
})
