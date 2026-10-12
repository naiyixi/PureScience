import { describe, expect, it } from 'vitest'

import { insertPngProvenanceText, stripImageMetadata } from './image-metadata'
import { crc32 as zlibCrc32 } from 'node:zlib'

// Hand-assembled containers: a real EXIF block would need a camera, and the point here is which segments
// survive, not what a specific camera wrote.
const jpegSegment = (marker: number, payload: number[]): number[] => [
  0xff,
  marker,
  ((payload.length + 2) >> 8) & 0xff,
  (payload.length + 2) & 0xff,
  ...payload
]

const jpeg = (segments: number[][]): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])

const APP0_JFIF = jpegSegment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00])
const APP1_EXIF = jpegSegment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0xde, 0xad])
const APP2_ICC = jpegSegment(0xe2, [0x49, 0x43, 0x43, 0x5f, 0x50])
const APP13_IPTC = jpegSegment(0xed, [0x50, 0x68, 0x6f, 0x74, 0x6f])
const COM = jpegSegment(0xfe, [0x68, 0x65, 0x6c, 0x6c, 0x6f])

const pngChunk = (type: string, payload: number[]): number[] => [
  (payload.length >> 24) & 0xff,
  (payload.length >> 16) & 0xff,
  (payload.length >> 8) & 0xff,
  payload.length & 0xff,
  ...[...type].map((character) => character.charCodeAt(0)),
  ...payload,
  0,
  0,
  0,
  0
]

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_IHDR = pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
const PNG_iCCP = pngChunk('iCCP', [1, 2, 3])
const PNG_tEXt = pngChunk('tEXt', [0x41, 0x75, 0x74, 0x68, 0x6f, 0x72])
const PNG_eXIf = pngChunk('eXIf', [0x4d, 0x4d, 0x00, 0x2a])
const PNG_IDAT = pngChunk('IDAT', [0x78, 0x9c])
const PNG_IEND = pngChunk('IEND', [])

const png = (chunks: number[][]): Uint8Array =>
  Uint8Array.from([...PNG_SIGNATURE, ...chunks.flat()])

const contains = (bytes: Uint8Array, needle: number[]): boolean =>
  [...bytes].some((_, start) => needle.every((byte, index) => bytes[start + index] === byte))

describe('image metadata stripping', () => {
  it('drops EXIF, IPTC and comments from a JPEG, and keeps the colour profile', () => {
    const original = jpeg([APP0_JFIF, APP1_EXIF, APP2_ICC, APP13_IPTC, COM])

    const stripped = stripImageMetadata(original)

    expect(stripped.removed).toEqual(['exif', 'iptc', 'comment'])
    expect(contains(stripped.bytes, APP1_EXIF)).toBe(false)
    expect(contains(stripped.bytes, APP13_IPTC)).toBe(false)
    expect(contains(stripped.bytes, COM)).toBe(false)
    // Colour is not an identifier: dropping the ICC profile would change how the image renders.
    expect(contains(stripped.bytes, APP2_ICC)).toBe(true)
    expect(contains(stripped.bytes, APP0_JFIF)).toBe(true)
    // The container is still a JPEG with its scan data intact.
    expect(stripped.bytes[0]).toBe(0xff)
    expect(stripped.bytes[1]).toBe(0xd8)
    expect(stripped.bytes.slice(-2)).toEqual(Uint8Array.from([0xff, 0xd9]))
    expect(stripped.bytes.length).toBe(
      original.length - (APP1_EXIF.length + APP13_IPTC.length + COM.length)
    )
  })

  it('drops PNG text and EXIF chunks, keeping pixels, colour and transparency facts', () => {
    const original = png([PNG_IHDR, PNG_iCCP, PNG_tEXt, PNG_eXIf, PNG_IDAT, PNG_IEND])

    const stripped = stripImageMetadata(original)

    expect(stripped.removed).toEqual(['text', 'exif'])
    expect(contains(stripped.bytes, PNG_tEXt)).toBe(false)
    expect(contains(stripped.bytes, PNG_eXIf)).toBe(false)
    expect(contains(stripped.bytes, PNG_iCCP)).toBe(true)
    expect(contains(stripped.bytes, PNG_IHDR)).toBe(true)
    expect(contains(stripped.bytes, PNG_IDAT)).toBe(true)
    expect(contains(stripped.bytes, PNG_IEND)).toBe(true)
    // The signature survives, so the result is still a decodable PNG.
    expect([...stripped.bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE)
  })

  it('returns the same bytes when there was nothing to remove, so callers can compare identity', () => {
    const clean = jpeg([APP0_JFIF, APP2_ICC])
    const pngClean = png([PNG_IHDR, PNG_IDAT, PNG_IEND])

    expect(stripImageMetadata(clean)).toEqual({ bytes: clean, removed: [] })
    expect(stripImageMetadata(pngClean).bytes).toBe(pngClean)
  })

  it('does not claim to strip a format it cannot read', () => {
    // TIFF is not covered. Saying nothing is honest; naming removals that did not happen is not.
    const tiff = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4])

    expect(stripImageMetadata(tiff)).toEqual({ bytes: tiff, removed: [] })
    expect(stripImageMetadata(Uint8Array.from([])).removed).toEqual([])
  })

  it('survives a truncated JPEG instead of inventing a shorter image', () => {
    const truncated = Uint8Array.from([0xff, 0xd8, ...APP0_JFIF.slice(0, 3)])

    // The segment header is cut mid-length: nothing can be judged, so nothing is dropped.
    expect(stripImageMetadata(truncated).removed).toEqual([])
  })
})

// ---- 另一半：导出时把事实写进图里（D4「导出后标签仍在」）-------------------------------------
// 这里**不借被测实现自己的 crc32**：CRC 用 node:zlib 的独立实现核，读块也用自己走一遍的结构。
const realChunk = (type: string, payload: number[]): number[] => {
  const body = [...[...type].map((character) => character.charCodeAt(0)), ...payload]
  const crc = zlibCrc32(Uint8Array.from(body))
  return [
    (payload.length >>> 24) & 0xff,
    (payload.length >>> 16) & 0xff,
    (payload.length >>> 8) & 0xff,
    payload.length & 0xff,
    ...body,
    (crc >>> 24) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 8) & 0xff,
    crc & 0xff
  ]
}

const realPng = (): Uint8Array =>
  Uint8Array.from([
    ...PNG_SIGNATURE,
    ...realChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    ...realChunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
    ...realChunk('IEND', [])
  ])

type ReadChunk = { type: string; data: Uint8Array; crcOk: boolean; start: number; end: number }

const readChunks = (bytes: Uint8Array): ReadChunk[] => {
  const chunks: ReadChunk[] = []
  let offset = PNG_SIGNATURE.length
  while (offset + 12 <= bytes.length) {
    const length =
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0
    const end = offset + 12 + length
    if (end > bytes.length) break
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    )
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const stored =
      ((bytes[end - 4] << 24) | (bytes[end - 3] << 16) | (bytes[end - 2] << 8) | bytes[end - 1]) >>>
      0
    const computed = zlibCrc32(
      Uint8Array.from([...[...type].map((character) => character.charCodeAt(0)), ...data])
    )
    chunks.push({ type, data, crcOk: stored === computed, start: offset, end })
    offset = end
  }
  return chunks
}

const itxtPayload = (data: Uint8Array): { keyword: string; text: string } => {
  const keywordEnd = data.indexOf(0)
  const keyword = Buffer.from(data.subarray(0, keywordEnd)).toString('latin1')
  expect(data[keywordEnd + 1]).toBe(0) // 压缩标志：未压缩
  expect(data[keywordEnd + 2]).toBe(0) // 压缩方法
  const languageEnd = data.indexOf(0, keywordEnd + 3)
  const translatedEnd = data.indexOf(0, languageEnd + 1)
  const text = new TextDecoder().decode(data.subarray(translatedEnd + 1))
  return { keyword, text }
}

describe('结构视图导出：把这块区域的名字与指纹写进 PNG', () => {
  const rows = [
    { keyword: 'PureScience-Label', text: '活性位点' },
    { keyword: 'PureScience-Fingerprint', text: 'structure-selection:v2-3f2a1b0c' }
  ]

  it('写进去的块能被独立读回（中文名字逐字回得来），且每一块的 CRC 都自洽', () => {
    const result = insertPngProvenanceText(realPng(), rows)
    expect(result.reason).toBeUndefined()
    expect(result.skipped).toEqual([])
    expect(result.inserted).toEqual(['PureScience-Label', 'PureScience-Fingerprint'])

    const chunks = readChunks(result.bytes)
    // 结构完好的 PNG：没有一块的 CRC 对不上（含原来那几块）。
    expect(chunks.filter((chunk) => !chunk.crcOk)).toEqual([])
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'iTXt', 'iTXt', 'IDAT', 'IEND'])
    // 正文用 UTF-8 独立解出来：中文名字**逐字**回得来（用 tEXt 这里会坏成乱码）。
    expect(
      chunks.filter((chunk) => chunk.type === 'iTXt').map((chunk) => itxtPayload(chunk.data))
    ).toEqual([
      { keyword: 'PureScience-Label', text: '活性位点' },
      { keyword: 'PureScience-Fingerprint', text: 'structure-selection:v2-3f2a1b0c' }
    ])
  })

  it('只碰元数据：去掉新块之后与原图逐字节相同（像素不可能被改，因为没有重编码）', () => {
    const source = realPng()
    const result = insertPngProvenanceText(source, rows)
    const kept = readChunks(result.bytes).filter((chunk) => chunk.type !== 'iTXt')
    const rebuilt = [
      ...PNG_SIGNATURE,
      ...kept.flatMap((chunk) => [...result.bytes.subarray(chunk.start, chunk.end)])
    ]
    expect(rebuilt).toEqual([...source])
  })

  it('与「出网剥除」是一对：写进去的正是交给模型前会被剥掉的那一类', () => {
    const result = insertPngProvenanceText(realPng(), rows)
    const stripped = stripImageMetadata(result.bytes)
    expect(stripped.removed).toEqual(['itxt', 'itxt'])
    // 剥完与**原图**逐字节相同 ⇒ 两半合起来是「导出带着、出网剥掉」：谁也没法把事实悄悄带出去。
    expect([...stripped.bytes]).toEqual([...realPng()])
  })

  it('失败与跳过都具名，且一个字节都不改', () => {
    const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x01])
    const notPng = insertPngProvenanceText(jpegBytes, rows)
    expect(notPng.reason).toBe('not-a-png')
    expect(notPng.inserted).toEqual([])
    expect([...notPng.bytes]).toEqual([...jpegBytes])

    // 签名对、IHDR 长度不对（3 而不是 13）⇒ 结构坏，不许往里插东西。
    const broken = Uint8Array.from([...PNG_SIGNATURE, ...pngChunk('IHDR', [1, 2, 3])])
    expect(insertPngProvenanceText(broken, rows).reason).toBe('malformed')

    // 空正文不写（在文件里留一句没有内容的话不是事实）；全跳过时**逐字节等于输入**。
    const emptyText = insertPngProvenanceText(realPng(), [
      { keyword: 'PureScience-Label', text: '' }
    ])
    expect(emptyText.skipped).toEqual([{ keyword: 'PureScience-Label', reason: 'empty-text' }])
    expect(emptyText.inserted).toEqual([])
    expect([...emptyText.bytes]).toEqual([...realPng()])

    // 关键字按规范是 Latin-1 可打印字符：中文关键字写不进去，要**具名跳过**而不是写一块坏的。
    const badKeyword = insertPngProvenanceText(realPng(), [{ keyword: '名字', text: 'x' }])
    expect(badKeyword.skipped).toEqual([{ keyword: '名字', reason: 'invalid-keyword' }])
    expect([...badKeyword.bytes]).toEqual([...realPng()])
  })
})
