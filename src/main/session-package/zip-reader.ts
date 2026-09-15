import { Inflate } from 'fflate'

import { readZipDirectory, type ZipEntryDeclaration } from './zip-directory'

// Expands the members a caller asks for, ONE AT A TIME, under hard ceilings.
//
// Why not `unzipSync`: it expands the entire archive into memory before anything can be judged, so a
// package's peak cost is the sum of its members. Reading the central directory first tells us where each
// member lives, and expanding a member alone bounds the expansion to that member. The archive bytes
// themselves are still held by the caller (it read the file), so the honest claim is: peak expansion =
// one member, never the package.
//
// Two independent guards, because a declaration can lie:
//   1. the declared size, checked before expanding anything (see zip-directory.ts);
//   2. the size the member ACTUALLY inflates to, checked while inflating and aborted the moment it
//      crosses the ceiling. A crafted archive cannot buy unbounded memory by understating its sizes.
export type ZipReaderLimits = {
  maxEntryBytes: number
  maxTotalBytes: number
}

export type ZipEntryRead =
  | { ok: true; entries: Map<string, Uint8Array> }
  | {
      ok: false
      reason: 'not-a-package' | 'zip64-not-admitted' | 'entry-too-large' | 'package-too-large'
    }

const LOCAL_FILE_HEADER = 0x04034b50
// A compressed bite small enough that one push's decoded output stays well under the per-member ceiling.
const INFLATE_INPUT_CHUNK_BYTES = 8 * 1024
const STORED = 0
const DEFLATED = 8

// One member, expanded alone, with its own ceiling enforced as it grows.
const expandEntry = (
  bytes: Uint8Array,
  entry: ZipEntryDeclaration,
  maxEntryBytes: number
): Uint8Array | 'entry-too-large' | 'not-a-package' => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const header = entry.localHeaderOffset
  if (header + 30 > bytes.byteLength) return 'not-a-package'
  if (view.getUint32(header, true) !== LOCAL_FILE_HEADER) return 'not-a-package'

  const nameLength = view.getUint16(header + 26, true)
  const extraLength = view.getUint16(header + 28, true)
  const start = header + 30 + nameLength + extraLength
  const end = start + entry.compressedBytes
  if (start > bytes.byteLength || end > bytes.byteLength) return 'not-a-package'
  const payload = bytes.subarray(start, end)

  if (entry.method === STORED) {
    if (payload.byteLength > maxEntryBytes) return 'entry-too-large'
    return payload.slice()
  }
  if (entry.method !== DEFLATED) return 'not-a-package'

  let total = 0
  const chunks: Uint8Array[] = []
  const inflater = new Inflate((chunk) => {
    total += chunk.byteLength
    chunks.push(chunk)
  })

  // Input is fed in bounded bites so a member that inflates far beyond its declaration can be abandoned
  // mid-stream: the compressed bytes are never handed over all at once, so the decompressed output never
  // gets the chance to grow past the ceiling (the overshoot is bounded by one bite). Refused rather than
  // truncated: a half member that looks whole is worse than a refusal.
  try {
    for (let offset = 0; offset < payload.byteLength; offset += INFLATE_INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + INFLATE_INPUT_CHUNK_BYTES, payload.byteLength)
      inflater.push(payload.subarray(offset, end), end >= payload.byteLength)
      if (total > maxEntryBytes) return 'entry-too-large'
    }
  } catch {
    return 'not-a-package'
  }
  if (total > maxEntryBytes) return 'entry-too-large'

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  // A deflate stream that produced nothing while claiming bytes is not a member we can trust.
  if (out.byteLength === 0 && entry.declaredBytes > 0) return 'not-a-package'
  return out
}

/**
 * Expands `only` (or every file member when it is omitted) of the archive, one member at a time.
 * Directory members and members the caller did not ask for cost nothing.
 */
export const readZipEntries = (
  bytes: Uint8Array,
  limits: ZipReaderLimits,
  options: { only?: readonly string[] } = {}
): ZipEntryRead => {
  const directory = readZipDirectory(bytes)
  if (!directory.ok) return { ok: false, reason: directory.reason }

  const wanted = options.only ? new Set(options.only) : undefined
  const entries = new Map<string, Uint8Array>()
  let expandedTotal = 0

  for (const entry of directory.entries) {
    if (entry.name.endsWith('/')) continue
    if (wanted && !wanted.has(entry.name)) continue
    // The declaration is checked before the member is touched; the expansion below checks reality.
    if (entry.declaredBytes > limits.maxEntryBytes) return { ok: false, reason: 'entry-too-large' }

    const expanded = expandEntry(bytes, entry, limits.maxEntryBytes)
    if (expanded === 'entry-too-large') return { ok: false, reason: 'entry-too-large' }
    if (expanded === 'not-a-package') return { ok: false, reason: 'not-a-package' }

    expandedTotal += expanded.byteLength
    if (expandedTotal > limits.maxTotalBytes) return { ok: false, reason: 'package-too-large' }
    entries.set(entry.name, expanded)
  }

  return { ok: true, entries }
}
