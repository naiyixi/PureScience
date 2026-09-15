// Removes identifying metadata from image bytes before they are handed to a model provider.
//
// A photograph carries where it was taken and with what; inlining the file verbatim would ship that to a
// third party together with the science. The strip is lossless for pixels: whole metadata segments are
// dropped, and nothing that decodes into the image is touched.
//
// Deliberately NOT a re-encode: re-encoding would change the pixels a model sees (and silently degrade a
// figure the user cares about). Only segments that carry metadata are removed, so what was visible stays
// byte-identical.
//
// Coverage is JPEG and PNG. Other formats (TIFF/WebP/GIF) are returned unchanged with an empty `removed`
// list — a caller must not claim they were stripped.
export type ImageMetadataStrip = {
  /** The bytes to send. Identical to the input when nothing was removed. */
  bytes: Uint8Array
  /** What was dropped, named — so a caller can say what it did rather than assume. */
  removed: readonly string[]
}

const JPEG_SOI = 0xffd8
const JPEG_SOS = 0xffda
const JPEG_EOI = 0xffd9

// APP1 carries EXIF (including GPS) and XMP; APP13 carries Photoshop/IPTC records; COM is a free-text
// comment. APP0/APP2 are kept on purpose: they are the JFIF header and the ICC colour profile, and
// dropping the colour profile would silently change how the image renders. Identifiers go, colour stays.
const JPEG_DROPPED_MARKERS = new Map<number, string>([
  [0xe1, 'exif'],
  [0xed, 'iptc'],
  [0xfe, 'comment']
])

const stripJpeg = (bytes: Uint8Array): ImageMetadataStrip => {
  const removed: string[] = []
  const kept: number[] = [bytes[0], bytes[1]]
  let offset = 2

  while (offset + 1 < bytes.length) {
    const marker = (bytes[offset] << 8) | bytes[offset + 1]
    if (marker === JPEG_EOI) break
    // Start of scan: everything after this is entropy-coded image data, copied verbatim.
    if (marker === JPEG_SOS) break
    if ((marker & 0xff00) !== 0xff00) break

    const lengthOffset = offset + 2
    if (lengthOffset + 1 >= bytes.length) break
    const segmentLength = (bytes[lengthOffset] << 8) | bytes[lengthOffset + 1]
    const segmentEnd = lengthOffset + segmentLength
    if (segmentLength < 2 || segmentEnd > bytes.length) break

    const name = JPEG_DROPPED_MARKERS.get(marker & 0xff)
    if (name) {
      removed.push(name)
    } else {
      for (let index = offset; index < segmentEnd; index += 1) kept.push(bytes[index])
    }
    offset = segmentEnd
  }

  if (removed.length === 0) return { bytes, removed }
  // The rest of the file (scan data, tables, end marker) is copied as-is: only metadata left the image.
  for (let index = offset; index < bytes.length; index += 1) kept.push(bytes[index])
  return { bytes: Uint8Array.from(kept), removed }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// PNG text chunks are the usual container for authoring metadata and free-form notes; eXIf is the PNG
// home for an EXIF block. Colour chunks (gAMA/iCCP/sRGB) and transparency (tRNS) are animation/colour
// facts, not identifiers, and stay.
const PNG_DROPPED_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf'])

const stripPng = (bytes: Uint8Array): ImageMetadataStrip => {
  const removed: string[] = []
  const kept: number[] = [...PNG_SIGNATURE]
  let offset = PNG_SIGNATURE.length

  while (offset + 8 <= bytes.length) {
    const length =
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    )
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) break

    if (PNG_DROPPED_CHUNKS.has(type)) {
      removed.push(type.toLowerCase())
    } else {
      // Each chunk's CRC covers its own type+data, so removing a whole chunk leaves the rest valid.
      for (let index = offset; index < chunkEnd; index += 1) kept.push(bytes[index])
    }
    offset = chunkEnd
  }

  if (removed.length === 0) return { bytes, removed }
  for (let index = offset; index < bytes.length; index += 1) kept.push(bytes[index])
  return { bytes: Uint8Array.from(kept), removed }
}

// The container is decided by its own magic bytes, never by a declared MIME type: a file named .jpg that
// holds something else must not be "stripped" on the strength of its name.
const isJpeg = (bytes: Uint8Array): boolean =>
  bytes.length > 2 && ((bytes[0] << 8) | bytes[1]) === JPEG_SOI

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)

export const stripImageMetadata = (bytes: Uint8Array): ImageMetadataStrip => {
  if (isJpeg(bytes)) return stripJpeg(bytes)
  if (isPng(bytes)) return stripPng(bytes)
  return { bytes, removed: [] }
}
