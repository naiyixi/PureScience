// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fingerprintPdfFile } from './pdf-fingerprint'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-fingerprint-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('fingerprintPdfFile', () => {
  it('records the head hash together with the exact byte size', async () => {
    const path = join(root, 'paper.pdf')
    await writeFile(path, 'PDF-CONTENT-1234', 'utf8')

    const fingerprint = await fingerprintPdfFile(path)
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}:16$/)
  })

  it('changes when the file content or size changes', async () => {
    const path = join(root, 'paper.pdf')
    await writeFile(path, 'ORIGINAL', 'utf8')
    const first = await fingerprintPdfFile(path)

    await writeFile(path, 'REPLACED', 'utf8')
    const second = await fingerprintPdfFile(path)
    expect(second).not.toBe(first)

    await writeFile(path, 'ORIGINAL!!', 'utf8')
    const third = await fingerprintPdfFile(path)
    expect(third).not.toBe(first)
    expect(third).not.toBe(second)
  })

  it('handles an empty file without reading a stream', async () => {
    const path = join(root, 'empty.pdf')
    await writeFile(path, '', 'utf8')
    const fingerprint = await fingerprintPdfFile(path)
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}:0$/)
  })
})
