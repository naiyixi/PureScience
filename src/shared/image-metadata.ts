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

// --- 另一半：**导出时**把产物自己的事实写进图里 -----------------------------------------------
//
// 上面那半管的是「交给模型之前」：任何文本块都剥掉，图像不带着作者/位置出网。
// 这半管管的是「写进用户自己的文件」：结构视图导出时，把这块区域的**名字与指纹**写进图里，
// 让它离开应用之后仍然说明自己是什么 —— 文件到了文件管理器/别的工具里，事实还在文件里。
//
// 两半是**故意的一对**：写进去的块，正是出网前会被剥掉的那一类（`PNG_DROPPED_CHUNKS`），
// 所以「导出带着、出网剥掉」这条性质由这两个函数共同保证 —— 改一半必须改另一半。
export type PngProvenanceText = { keyword: string; text: string }

export type PngProvenanceInsertion = {
  /** 输入加上文本块。没写进去任何东西时**逐字节等于输入**。 */
  bytes: Uint8Array
  /** 真的写进去的 keyword（调用方据此如实说写了什么，不是打算写什么）。 */
  inserted: readonly string[]
  /** 逐项被跳过的事实与原因 —— 跳过必须说得出为什么。 */
  skipped: readonly { keyword: string; reason: 'invalid-keyword' | 'empty-text' }[]
  /** 整体失败：不是 PNG / 结构不对（此时不改动一个字节）。 */
  reason?: 'not-a-png' | 'malformed'
}

// IHDR 固定 13 字节数据；文本块只能插在它之后（规范允许的位置里最保守的一个）。
const PNG_IHDR_END = PNG_SIGNATURE.length + 8 + 13 + 4

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 关键字按 PNG 规范是 Latin-1 的 1..79 个可打印字符（我的关键字都是 ASCII，但判据不靠这个假设）。 */
const latin1Keyword = (keyword: string): Uint8Array | undefined => {
  if (keyword.length < 1 || keyword.length > 79) return undefined
  const bytes = new Uint8Array(keyword.length)
  for (let index = 0; index < keyword.length; index += 1) {
    const code = keyword.charCodeAt(index)
    if (code < 32 || code > 126) return undefined
    bytes[index] = code
  }
  if (bytes[0] === 32 || bytes[bytes.length - 1] === 32) return undefined
  return bytes
}

const writeUint32 = (target: Uint8Array, offset: number, value: number): void => {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

const readUint32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>>
  0

// 用 iTXt 而不是 tEXt：名字是中文（「活性位点」），tEXt 只能放 Latin-1，会把它写成乱码。
// 不压缩（compression flag 0）：这样文件里的字节就是可读的原文，取证时肉眼可核。
const buildItxtChunk = (keyword: Uint8Array, textBytes: Uint8Array): Uint8Array => {
  const data = new Uint8Array(keyword.length + 5 + textBytes.length)
  data.set(keyword, 0)
  let cursor = keyword.length
  data[cursor] = 0 // 关键字结束
  data[cursor + 1] = 0 // 压缩标志：未压缩
  data[cursor + 2] = 0 // 压缩方法
  data[cursor + 3] = 0 // 语言标签：空
  data[cursor + 4] = 0 // 译名：空
  cursor += 5
  data.set(textBytes, cursor)

  const chunk = new Uint8Array(12 + data.length)
  writeUint32(chunk, 0, data.length)
  chunk[4] = 0x69
  chunk[5] = 0x54
  chunk[6] = 0x58
  chunk[7] = 0x74 // 'iTXt'
  chunk.set(data, 8)
  writeUint32(chunk, 8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))
  return chunk
}

/**
 * 把 provenance 文本块插进 **PNG**（插在 IHDR 之后）。
 * 只碰元数据：IHDR/IDAT/IEND 与其余字节逐字未动（像素不可能被改变，因为根本没有重编码）。
 */
export const insertPngProvenanceText = (
  bytes: Uint8Array,
  items: readonly PngProvenanceText[]
): PngProvenanceInsertion => {
  if (!isPng(bytes)) return { bytes, inserted: [], skipped: [], reason: 'not-a-png' }
  if (
    PNG_IHDR_END > bytes.length ||
    readUint32(bytes, PNG_SIGNATURE.length) !== 13 ||
    String.fromCharCode(
      bytes[PNG_SIGNATURE.length + 4],
      bytes[PNG_SIGNATURE.length + 5],
      bytes[PNG_SIGNATURE.length + 6],
      bytes[PNG_SIGNATURE.length + 7]
    ) !== 'IHDR'
  ) {
    return { bytes, inserted: [], skipped: [], reason: 'malformed' }
  }

  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const inserted: string[] = []
  const skipped: { keyword: string; reason: 'invalid-keyword' | 'empty-text' }[] = []

  for (const item of items) {
    const keyword = latin1Keyword(item.keyword)
    if (!keyword) {
      skipped.push({ keyword: item.keyword, reason: 'invalid-keyword' })
      continue
    }
    // 空的文本行不写：写一个空事实进文件等于在文件里留一句没有内容的话。
    if (item.text.length === 0) {
      skipped.push({ keyword: item.keyword, reason: 'empty-text' })
      continue
    }
    chunks.push(buildItxtChunk(keyword, encoder.encode(item.text)))
    inserted.push(item.keyword)
  }

  if (chunks.length === 0) return { bytes, inserted, skipped }

  const added = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const output = new Uint8Array(bytes.length + added)
  output.set(bytes.subarray(0, PNG_IHDR_END), 0)
  let cursor = PNG_IHDR_END
  for (const chunk of chunks) {
    output.set(chunk, cursor)
    cursor += chunk.length
  }
  output.set(bytes.subarray(PNG_IHDR_END), cursor)
  return { bytes: output, inserted, skipped }
}
