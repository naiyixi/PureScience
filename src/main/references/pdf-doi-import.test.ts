import { describe, expect, it, vi } from 'vitest'

import type { CreateReferenceInput } from '../../shared/references'
import { importReferencesFromPdfText, type PdfDoiImportPorts } from './pdf-doi-import'

const input = (doi: string): CreateReferenceInput =>
  ({ projectId: 'project-a', title: `Work ${doi}`, doi }) as CreateReferenceInput

const ports = (text: string, overrides: Partial<PdfDoiImportPorts> = {}): PdfDoiImportPorts => ({
  readText: vi.fn().mockResolvedValue(text),
  resolve: vi.fn(async (doi: string) => (doi.includes('dead') ? undefined : input(doi))),
  add: vi.fn(async (value: CreateReferenceInput) => ({
    status: 'created' as const,
    referenceId: `ref:${value.doi}`
  })),
  ...overrides
})

describe('import references from a PDF', () => {
  it('creates one reference per resolvable identifier and reads only what it needs', async () => {
    const p = ports('Intro cites 10.1038/nature12373 and later 10.1126/science.abc1234.')

    const result = await importReferencesFromPdfText(p)

    expect(result.created).toBe(2)
    expect(result.truncated).toBe(0)
    expect(result.outcomes.map((outcome) => outcome.doi)).toEqual([
      '10.1038/nature12373',
      '10.1126/science.abc1234'
    ])
    // Resolution went through the same path a typed identifier takes, not a second implementation.
    expect(p.resolve).toHaveBeenCalledTimes(2)
  })

  // The anti-shell rule: a PDF whose DOI cannot be resolved must say so, not invent a reference.
  it('names an identifier that resolves to nothing instead of inventing metadata', async () => {
    const p = ports('See 10.1002/dead.2020.001 and 10.1038/nature12373.')

    const result = await importReferencesFromPdfText(p)

    expect(result.created).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.outcomes).toEqual([
      { doi: '10.1002/dead.2020.001', status: 'failed', reason: 'no metadata found for this DOI' },
      { doi: '10.1038/nature12373', status: 'created', referenceId: 'ref:10.1038/nature12373' }
    ])
  })

  it('treats an already-present reference as a duplicate rather than an error', async () => {
    const p = ports('10.1038/nature12373', {
      add: vi.fn(async () => ({ status: 'duplicate' as const, referenceId: 'ref-existing' }))
    })

    const result = await importReferencesFromPdfText(p)

    expect(result.duplicates).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.outcomes[0]).toMatchObject({ status: 'duplicate', referenceId: 'ref-existing' })
  })

  // The bound is the point: a review PDF cites dozens of works, and importing all of them in one
  // action is not what the reader asked for. What the cap left behind is reported.
  it('stops at the per-document cap and reports what it left behind', async () => {
    const text = Array.from({ length: 9 }, (_, index) => `10.1000/work.${index}`).join(' ')
    const p = ports(text)

    const result = await importReferencesFromPdfText(p, { limit: 3 })

    expect(result.created).toBe(3)
    expect(result.truncated).toBe(6)
    expect(result.outcomes).toHaveLength(3)
  })

  it('keeps going when one identifier throws, and names that one', async () => {
    const resolve = vi.fn(async (doi: string) => {
      if (doi.includes('boom')) throw new Error('resolver offline')
      return input(doi)
    })
    const p = ports('10.1000/boom.1 10.1038/nature12373', { resolve })

    const result = await importReferencesFromPdfText(p)

    expect(result.created).toBe(1)
    expect(result.outcomes[0]).toEqual({
      doi: '10.1000/boom.1',
      status: 'failed',
      reason: 'resolver offline'
    })
  })

  it('is a no-op for text without identifiers', async () => {
    const p = ports('Figure 1 shows the pipeline. No citations here.')

    const result = await importReferencesFromPdfText(p)

    expect(result.outcomes).toEqual([])
    expect(result.created).toBe(0)
    expect(p.resolve).not.toHaveBeenCalled()
  })
})
