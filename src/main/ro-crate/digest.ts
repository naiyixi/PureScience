// Byte digests for the RO-Crate surface, in one place.
//
// Both sides of that surface have to agree on what "the file's sha256" means: the writer hashes the bytes it
// just copied into a crate, and the reader hashes the bytes a crate this app did NOT write actually holds.
// The comparison `file-sha256-matches-copied-bytes` is only as strong as that shared meaning, so the hasher
// lives here rather than being spelled again next to each caller.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'

import type { RoCratePayloadDigest } from '../../shared/ro-crate'

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

// What is on disk, recounted — never the digest the document claims for itself.
//
// Reading is streamed on purpose: a payload is arbitrary bytes chosen by whoever wrote the crate, so the
// answer must not depend on the file fitting in memory. `undefined` means "no digest", which callers must
// report as a FAILED check rather than skip — a declared file that cannot be read is exactly the kind of
// thing the read-only half exists to name.
//
// The mode check comes first, on the link itself: a symlink inside someone else's crate could point at
// anything, and hashing its target would attribute bytes to this crate that do not belong to it.
export const digestOfFile = async (path: string): Promise<RoCratePayloadDigest | undefined> => {
  try {
    const info = await lstat(path)
    if (!info.isFile()) return undefined
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array)
    return { sizeBytes: info.size, sha256: hash.digest('hex') }
  } catch {
    return undefined
  }
}
