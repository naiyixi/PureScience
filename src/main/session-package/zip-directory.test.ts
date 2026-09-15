import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { readZipDirectory } from './zip-directory'

describe('zip central directory reader', () => {
  it('reports each member and the size it declares, without expanding anything', () => {
    const archive = zipSync({
      'conversation.json': strToU8('{"messages":[]}'),
      'evidence/citations.json': strToU8('[]'),
      'files/big.bin': new Uint8Array(2000)
    })

    const directory = readZipDirectory(archive)

    expect(directory.ok).toBe(true)
    if (!directory.ok) return
    const byName = new Map(directory.entries.map((entry) => [entry.name, entry.declaredBytes]))
    expect([...byName.keys()].sort()).toEqual([
      'conversation.json',
      'evidence/citations.json',
      'files/big.bin'
    ])
    expect(byName.get('files/big.bin')).toBe(2000)
    expect(byName.get('evidence/citations.json')).toBe(2)
  })

  it('reports the entry count a hostile archive would need to inflate', () => {
    const many: Record<string, Uint8Array> = {}
    for (let index = 0; index < 50; index += 1) many[`filler/${index}.json`] = strToU8('{}')

    const directory = readZipDirectory(zipSync(many))
    expect(directory.ok && directory.entries.length).toBe(50)
  })

  it('refuses bytes that are not an archive', () => {
    expect(readZipDirectory(strToU8('definitely not a zip'))).toEqual({
      ok: false,
      reason: 'not-a-package'
    })
    expect(readZipDirectory(new Uint8Array(4))).toEqual({ ok: false, reason: 'not-a-package' })
  })

  it('refuses a directory that points outside the archive', () => {
    const archive = zipSync({ 'a.json': strToU8('{}') })
    // Corrupt the central-directory offset so it claims to live past the end of the file.
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    let endOffset = -1
    for (let offset = archive.byteLength - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        endOffset = offset
        break
      }
    }
    expect(endOffset).toBeGreaterThan(0)
    view.setUint32(endOffset + 16, 0x7fffffff, true)

    expect(readZipDirectory(archive)).toEqual({ ok: false, reason: 'not-a-package' })
  })
})
