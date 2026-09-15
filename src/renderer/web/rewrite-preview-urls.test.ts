import { describe, expect, it } from 'vitest'

import { rewritePreviewUrls } from './rewrite-preview-urls'

describe('rewritePreviewUrls', () => {
  it('rewrites the preview scheme wherever it appears', () => {
    const rewritten = rewritePreviewUrls({
      resource: { url: 'purescience-preview://resource-1/report.pdf' },
      list: ['purescience-preview://resource-2/other.pdf', 'plain']
    }) as { resource: { url: string }; list: string[] }

    expect(rewritten.resource.url).toBe('/preview/resource-1/report.pdf')
    expect(rewritten.list[0]).toBe('/preview/resource-2/other.pdf')
    expect(rewritten.list[1]).toBe('plain')
  })

  it('leaves a byte array a byte array', () => {
    // The walk rebuilds every object it meets, and a Uint8Array is an object: rebuilding it turned PDF
    // range reads into a map of indices ({0: 37, 1: 80, …}) and the preview failed on every chunk.
    const bytes = new Uint8Array([37, 80, 68, 70])
    const rewritten = rewritePreviewUrls({ begin: 0, end: 4, data: bytes }) as {
      data: unknown
    }

    expect(rewritten.data).toBeInstanceOf(Uint8Array)
    expect(ArrayBuffer.isView(rewritten.data)).toBe(true)
    expect((rewritten.data as Uint8Array).byteLength).toBe(4)
    expect((rewritten.data as Uint8Array)[0]).toBe(37)
  })

  it('leaves binary nested inside arrays and objects alone', () => {
    const buffer = new ArrayBuffer(3)
    const view = new DataView(buffer)
    const rewritten = rewritePreviewUrls([{ chunks: [view] }]) as [{ chunks: [unknown] }]

    expect(rewritten[0].chunks[0]).toBe(view)
  })

  it('does not turn a date into an empty object', () => {
    const date = new Date('2026-09-15T00:00:00.000Z')
    const rewritten = rewritePreviewUrls({ createdAt: date }) as { createdAt: unknown }

    expect(rewritten.createdAt).toBeInstanceOf(Date)
    expect((rewritten.createdAt as Date).toISOString()).toBe('2026-09-15T00:00:00.000Z')
  })
})
