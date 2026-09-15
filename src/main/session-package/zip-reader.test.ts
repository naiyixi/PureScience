import { strFromU8, strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { readZipEntries } from './zip-reader'

const LIMITS = { maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }

const text = (value: Uint8Array | undefined): string | undefined =>
  value ? strFromU8(value) : undefined

// Patches the size the central directory CLAIMS for one member, which is how a hostile archive understates
// its cost. The member's real content is untouched, so only the actual-size guard can catch this.
const understateCentralDirectorySize = (
  archive: Uint8Array,
  name: string,
  claim: number
): Uint8Array => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const decoder = new TextDecoder()
  for (let offset = 0; offset + 46 <= archive.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const entryName = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    if (entryName !== name) continue
    view.setUint32(offset + 24, claim, true)
    return archive
  }
  throw new Error(`no central directory entry named ${name}`)
}

describe('bounded zip reader', () => {
  it('expands only the members the caller asked for', () => {
    const archive = zipSync({
      'conversation.json': strToU8('{"messages":[]}'),
      'manifest.json': strToU8('{"schema":1}'),
      'files/huge.bin': new Uint8Array(512 * 1024)
    })

    const read = readZipEntries(archive, LIMITS, { only: ['conversation.json'] })

    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect([...read.entries.keys()]).toEqual(['conversation.json'])
    expect(text(read.entries.get('conversation.json'))).toBe('{"messages":[]}')
  })

  it('round-trips stored and deflated members when it expands everything', () => {
    const archive = zipSync({
      'stored.txt': [strToU8('stored payload'), { level: 0 }],
      'deflated.json': strToU8('{"a":1,"b":"'.concat('x'.repeat(5000), '"}'))
    })

    const read = readZipEntries(archive, LIMITS)

    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(text(read.entries.get('stored.txt'))).toBe('stored payload')
    expect(read.entries.get('deflated.json')?.byteLength).toBeGreaterThan(5000)
  })

  it('refuses a member that actually inflates past the ceiling even when the archive understates it', () => {
    const archive = understateCentralDirectorySize(
      zipSync({ 'files/liar.bin': new Uint8Array(200 * 1024).fill(7) }),
      'files/liar.bin',
      64
    )

    const read = readZipEntries(archive, { maxEntryBytes: 1024, maxTotalBytes: 4 * 1024 * 1024 })

    // The declaration says 64 bytes; the member really expands to 200 KB. Only the actual-size guard can
    // see this, which is why both guards exist.
    expect(read).toEqual({ ok: false, reason: 'entry-too-large' })
  })

  it('refuses a package whose expanded total exceeds the ceiling', () => {
    const archive = zipSync({
      'a.bin': new Uint8Array(700 * 1024),
      'b.bin': new Uint8Array(700 * 1024)
    })

    const read = readZipEntries(archive, { maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 })

    expect(read).toEqual({ ok: false, reason: 'package-too-large' })
  })

  it('reports bytes that are not a package instead of guessing', () => {
    expect(readZipEntries(strToU8('not a zip at all, just text'), LIMITS)).toEqual({
      ok: false,
      reason: 'not-a-package'
    })
    expect(readZipEntries(new Uint8Array(0), LIMITS)).toEqual({
      ok: false,
      reason: 'not-a-package'
    })
  })

  it('ignores directory members, which carry no content', () => {
    const archive = zipSync({ 'files/': new Uint8Array(0), 'files/a.txt': strToU8('a') })

    const read = readZipEntries(archive, LIMITS)

    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect([...read.entries.keys()]).toEqual(['files/a.txt'])
  })
})
