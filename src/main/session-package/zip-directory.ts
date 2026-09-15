// Readers of a package must refuse an oversized member BEFORE it is expanded, and the only synchronous
// way to know a member's size without expanding it is the archive's own central directory. This reads
// just that: the end-of-central-directory record and the entries it points at. No decompression happens
// here, so a hostile archive cannot cost more memory than the archive itself.
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50
const ZIP64_SIZE_MARKER = 0xffffffff

export type ZipEntryDeclaration = {
  name: string
  /** The size the archive claims the member will expand to. */
  declaredBytes: number
  /** Where the member's local header sits, its compression method, and its stored (compressed) size. */
  localHeaderOffset: number
  method: number
  compressedBytes: number
}

export type ZipDirectoryRead =
  | { ok: true; entries: ZipEntryDeclaration[] }
  // `not-a-package`: no readable directory. `zip64-not-admitted`: the archive uses the 64-bit escape,
  // whose real sizes live in a per-entry extra field this reader deliberately does not interpret — an
  // unbounded member is refused rather than guessed at.
  | { ok: false; reason: 'not-a-package' | 'zip64-not-admitted' }

const findEndOfCentralDirectory = (view: DataView): number => {
  // The record sits at the very end apart from an optional comment of up to 65535 bytes.
  const earliest = Math.max(0, view.byteLength - 65_557)
  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset
  }
  return -1
}

export const readZipDirectory = (bytes: Uint8Array): ZipDirectoryRead => {
  if (bytes.byteLength < 22) return { ok: false, reason: 'not-a-package' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const endOffset = findEndOfCentralDirectory(view)
  if (endOffset < 0) return { ok: false, reason: 'not-a-package' }

  const entryCount = view.getUint16(endOffset + 10, true)
  let offset = view.getUint32(endOffset + 16, true)
  const directorySize = view.getUint32(endOffset + 12, true)
  if (offset <= 0 || offset + directorySize > view.byteLength)
    return { ok: false, reason: 'not-a-package' }

  const entries: ZipEntryDeclaration[] = []
  const decoder = new TextDecoder()
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength) return { ok: false, reason: 'not-a-package' }
    if (view.getUint32(offset, true) !== CENTRAL_FILE_HEADER)
      return { ok: false, reason: 'not-a-package' }

    const compressedBytes = view.getUint32(offset + 20, true)
    const declaredBytes = view.getUint32(offset + 24, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const method = view.getUint16(offset + 10, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)

    if (compressedBytes === ZIP64_SIZE_MARKER || declaredBytes === ZIP64_SIZE_MARKER) {
      return { ok: false, reason: 'zip64-not-admitted' }
    }

    const nameStart = offset + 46
    if (nameStart + nameLength > view.byteLength) return { ok: false, reason: 'not-a-package' }
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    entries.push({ name, declaredBytes, localHeaderOffset, method, compressedBytes })
    offset = nameStart + nameLength + extraLength + commentLength
  }

  return { ok: true, entries }
}
