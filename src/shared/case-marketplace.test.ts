import { describe, expect, it } from 'vitest'

import {
  CASE_MARKETPLACE_FORMAT,
  CASE_MARKETPLACE_VERSION,
  searchMarketplaceCases,
  validateCaseMarketplaceIndex
} from './case-marketplace'

const digest = 'a'.repeat(64)

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'gpcr-activation',
  name: 'GPCR 激活途径',
  domain: 'structure',
  summary: '采样收敛与滞后审计',
  author: 'Able',
  license: 'MIT',
  bundleUrl: 'https://github.com/naiyixi/PureScience/releases/download/case-index/gpcr.tar.gz',
  bundleSha256: digest,
  fileCount: 12,
  totalBytes: 3400000,
  publishedAt: 1_760_000_000_000,
  ...overrides
})

const index = (cases: unknown[], overrides: Record<string, unknown> = {}): unknown => ({
  format: CASE_MARKETPLACE_FORMAT,
  version: CASE_MARKETPLACE_VERSION,
  updatedAt: 1_760_000_000_000,
  cases,
  ...overrides
})

describe('case marketplace index', () => {
  it('accepts a well-formed index and keeps the fields a card needs', () => {
    const result = validateCaseMarketplaceIndex(index([entry()]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.index.cases).toHaveLength(1)
    expect(result.index.cases[0]).toMatchObject({
      id: 'gpcr-activation',
      name: 'GPCR 激活途径',
      author: 'Able',
      license: 'MIT',
      fileCount: 12
    })
  })

  it('refuses documents it cannot read, each with its own name', () => {
    expect(validateCaseMarketplaceIndex(null)).toEqual({ ok: false, problem: 'bad-index' })
    expect(validateCaseMarketplaceIndex({ format: 'other', version: 1, cases: [] })).toEqual({
      ok: false,
      problem: 'unknown-format'
    })
    expect(validateCaseMarketplaceIndex(index([entry()], { version: 2 }))).toMatchObject({
      problem: 'unsupported-version',
      detail: '2'
    })
  })

  it('refuses an empty index instead of rendering an empty shelf', () => {
    expect(validateCaseMarketplaceIndex(index([]))).toEqual({ ok: false, problem: 'no-cases' })
  })

  it('names the entry that is malformed rather than failing the whole document vaguely', () => {
    expect(validateCaseMarketplaceIndex(index([entry({ id: '  ' })]))).toMatchObject({
      problem: 'bad-case-entry'
    })
    expect(validateCaseMarketplaceIndex(index([entry({ author: 7 })]))).toMatchObject({
      problem: 'bad-case-entry',
      detail: 'gpcr-activation'
    })
  })

  it('refuses two cases claiming one id — an installed copy could not tell them apart', () => {
    expect(validateCaseMarketplaceIndex(index([entry(), entry({ name: '另一个' })]))).toEqual({
      ok: false,
      problem: 'duplicate-id',
      detail: 'gpcr-activation'
    })
  })

  it('refuses links that are not plain https, and archives that are not pinned', () => {
    expect(
      validateCaseMarketplaceIndex(index([entry({ bundleUrl: 'http://example.com/a.tar.gz' })]))
    ).toMatchObject({ problem: 'bad-url' })
    expect(
      validateCaseMarketplaceIndex(
        index([entry({ bundleUrl: 'https://user:pw@example.com/a.tar.gz' })])
      )
    ).toMatchObject({ problem: 'bad-url' })
    expect(validateCaseMarketplaceIndex(index([entry({ bundleSha256: 'abc' })]))).toMatchObject({
      problem: 'bad-sha256'
    })
  })

  it('normalises an upper-case digest instead of rejecting a correct one', () => {
    const result = validateCaseMarketplaceIndex(
      index([entry({ bundleSha256: digest.toUpperCase() })])
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.index.cases[0].bundleSha256).toBe(digest)
  })
})

describe('searching the shelf', () => {
  const cases = [
    entry({ id: 'a', name: 'GPCR 激活途径', domain: 'structure', author: 'Able' }),
    entry({ id: 'b', name: 'mRNA-LNP', domain: 'formulation', author: 'Mistral' })
  ]
  const parsed = validateCaseMarketplaceIndex(index(cases))
  if (!parsed.ok) throw new Error('fixture rejected')

  it('returns everything for an empty query', () => {
    expect(searchMarketplaceCases(parsed.index, '   ')).toHaveLength(2)
  })

  it('searches the case name, the domain and the publisher — nothing else', () => {
    expect(searchMarketplaceCases(parsed.index, 'mrna')).toHaveLength(1)
    expect(searchMarketplaceCases(parsed.index, 'formulation')).toHaveLength(1)
    expect(searchMarketplaceCases(parsed.index, 'mistral')).toHaveLength(1)
    // A word that appears only in the summary is not a search key: the card shows it, the shelf does not match on it.
    expect(searchMarketplaceCases(parsed.index, '采样收敛')).toHaveLength(0)
  })
})
