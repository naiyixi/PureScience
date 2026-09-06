// Host-query engine tests: SELECT-only validation, table allowlist, cross-database rejection,
// project scoping (post-filter), row cap, and result normalization.

import { describe, expect, it, vi } from 'vitest'

import {
  HostQueryService,
  HostQueryValidationError,
  validateHostQuerySql
} from './host-query-service'

describe('validateHostQuerySql', () => {
  it('accepts a SELECT on an allowlisted table', () => {
    expect(validateHostQuerySql('SELECT id, status FROM Review LIMIT 5')).toEqual(['Review'])
  })

  it('rejects non-SELECT statements', () => {
    expect(() => validateHostQuerySql('DELETE FROM Review')).toThrow(HostQueryValidationError)
    expect(() => validateHostQuerySql('INSERT INTO Review VALUES (1)')).toThrow(
      HostQueryValidationError
    )
    expect(() => validateHostQuerySql('UPDATE Review SET status = 1')).toThrow(
      HostQueryValidationError
    )
  })

  it('rejects multi-statement and comments', () => {
    expect(() => validateHostQuerySql('SELECT 1; DROP TABLE Review')).toThrow(/semicolon/)
    expect(() => validateHostQuerySql('SELECT 1 -- comment')).toThrow(/comment/)
  })

  it('rejects cross-database references', () => {
    expect(() => validateHostQuerySql('SELECT * FROM main.Review')).toThrow(/cross-database/i)
  })

  it('rejects non-allowlisted tables', () => {
    expect(() => validateHostQuerySql('SELECT * FROM SecretTable')).toThrow(/allowlist/)
    expect(() => validateHostQuerySql('SELECT * FROM sqlite_master')).toThrow(/allowlist/)
  })

  it('accepts quoted identifiers and JOINs on allowed tables', () => {
    const tables = validateHostQuerySql('SELECT * FROM "Review" JOIN "Finding" ON 1=1 LIMIT 1')
    expect(tables.sort()).toEqual(['Finding', 'Review'])
  })

  it('rejects overlong SQL', () => {
    expect(() => validateHostQuerySql(`SELECT '${'x'.repeat(5000)}'`)).toThrow(/chars/)
  })
})

describe('HostQueryService', () => {
  it('runs a query and normalizes rows', async () => {
    const getClient = vi.fn(async () => ({
      $queryRawUnsafe: vi.fn(async () => [
        { id: 1, name: 'proj', archived: false, createdAt: new Date('2026-01-01') },
        { id: 2, name: 'other', archived: true, createdAt: new Date('2026-01-02') }
      ])
    }))
    const service = new HostQueryService({ getClient: getClient as never })
    const result = await service.query('SELECT * FROM Project', undefined)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]?.createdAt).toContain('2026-01-01')
    expect(result.rows[1]?.archived).toBe(true)
  })

  it('scopes rows to the caller project (post-filter)', async () => {
    const getClient = vi.fn(async () => ({
      $queryRawUnsafe: vi.fn(async () => [
        { projectId: 'p1', status: 'open' },
        { projectId: 'p2', status: 'open' },
        { projectId: 'p1', status: 'closed' }
      ])
    }))
    const service = new HostQueryService({ getClient: getClient as never })
    const result = await service.query('SELECT * FROM Finding', 'p1')
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((row) => row.projectId === 'p1')).toBe(true)
    expect(result.scopedToProject).toBe(true)
  })

  it('caps rows at 200 and marks truncated', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: i }))
    const getClient = vi.fn(async () => ({ $queryRawUnsafe: vi.fn(async () => rows) }))
    const service = new HostQueryService({ getClient: getClient as never })
    const result = await service.query('SELECT * FROM Project', undefined)
    expect(result.rows).toHaveLength(200)
    expect(result.truncated).toBe(true)
  })

  it('validates before touching the client', async () => {
    const getClient = vi.fn()
    const service = new HostQueryService({ getClient: getClient as never })
    await expect(service.query('DROP TABLE Review', 'p1')).rejects.toThrow(HostQueryValidationError)
    expect(getClient).not.toHaveBeenCalled()
  })

  it('surfaces query engine failures as errors', async () => {
    const getClient = vi.fn(async () => ({
      $queryRawUnsafe: vi.fn(async () => {
        throw new Error('no such table')
      })
    }))
    const service = new HostQueryService({ getClient: getClient as never })
    await expect(service.query('SELECT * FROM Review', undefined)).rejects.toThrow(/no such table/)
  })
})
