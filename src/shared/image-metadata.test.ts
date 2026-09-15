import { describe, expect, it } from 'vitest'

import { stripImageMetadata } from './image-metadata'

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
