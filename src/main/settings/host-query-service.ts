// Host-query introspection engine: READ-ONLY SQL over the app SQLite store with fail-closed
// safety. Mirrors the reference product's host.query: SELECT-only validation (no multi-statement,
// no comments, no "main." cross-database prefixes), an allowlisted set of self-awareness tables,
// a 200-row cap, and automatic project scoping via post-filtering (rows that carry a projectId
// field are kept only when they match the caller's project — the SQL itself is never rewritten,
// so there is no injection surface in the scoping).

import type { PrismaClient } from '@prisma/client'

import {
  HOST_QUERY_ALLOWED_TABLES,
  HOST_QUERY_MAX_ROWS,
  HOST_QUERY_MAX_SQL_LENGTH,
  type HostQueryResult,
  type HostQueryRow
} from '../../shared/host-query'

export class HostQueryValidationError extends Error {
  readonly code:
    'not_select' | 'too_long' | 'disallowed_table' | 'multi_statement' | 'cross_database'

  constructor(code: HostQueryValidationError['code'], message: string) {
    super(message)
    this.name = 'HostQueryValidationError'
    this.code = code
  }
}

// Validates a candidate SQL string and returns the quoted table names it references.
export const validateHostQuerySql = (sql: string): string[] => {
  const trimmed = sql.trim()
  if (trimmed.length > HOST_QUERY_MAX_SQL_LENGTH) {
    throw new HostQueryValidationError(
      'too_long',
      `SQL exceeds ${HOST_QUERY_MAX_SQL_LENGTH} chars.`
    )
  }
  if (!/^select\b/i.test(trimmed)) {
    throw new HostQueryValidationError('not_select', 'Only SELECT statements are allowed.')
  }
  if (/;/.test(trimmed)) {
    throw new HostQueryValidationError(
      'multi_statement',
      'Multiple statements are not allowed (no semicolons).'
    )
  }
  if (/--|\/\*|\*\//.test(trimmed)) {
    throw new HostQueryValidationError('multi_statement', 'SQL comments are not allowed.')
  }
  if (/main\.\w+/i.test(trimmed)) {
    throw new HostQueryValidationError(
      'cross_database',
      'Cross-database references (main.table) are not allowed.'
    )
  }
  if (
    /\b(insert|update|delete|drop|alter|create|replace|attach|pragma|vacuum|reindex)\b/i.test(
      trimmed
    )
  ) {
    throw new HostQueryValidationError('not_select', 'Only SELECT statements are allowed.')
  }

  // Extract table references: after FROM / JOIN keywords, quoted ("Name") or bare identifiers.
  const tables = new Set<string>()
  const pattern = /(?:\bfrom\b|\bjoin\b)\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(trimmed)) !== null) {
    const table = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (table) tables.add(table)
  }
  for (const table of tables) {
    if (!(HOST_QUERY_ALLOWED_TABLES as readonly string[]).includes(table)) {
      throw new HostQueryValidationError(
        'disallowed_table',
        `Table "${table}" is not in the self-awareness allowlist.`
      )
    }
  }
  if (tables.size === 0) {
    throw new HostQueryValidationError(
      'disallowed_table',
      'No allowed table referenced — include a FROM clause with an allowlisted table.'
    )
  }
  return [...tables]
}

export type HostQueryServiceDeps = {
  // Resolves the app Prisma client (the SQLite store).
  getClient: () => Promise<PrismaClient>
}

export class HostQueryService {
  constructor(private readonly deps: HostQueryServiceDeps) {}

  // Runs a validated read-only query, scopes rows to the project (post-filter), caps at 200.
  async query(sql: string, projectId: string | undefined): Promise<HostQueryResult> {
    validateHostQuerySql(sql)
    const client = await this.deps.getClient()
    const startedAt = performance.now()

    let rows: unknown[]
    try {
      rows = (await client.$queryRawUnsafe(sql)) as unknown[]
    } catch (error) {
      throw new Error(`Query failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const elapsedMs = Math.round(performance.now() - startedAt)

    let scoped = false
    const scopedRows: HostQueryRow[] = []
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const row = raw as Record<string, unknown>
      const rowProjectId = row['projectId'] ?? row['project_id']
      if (typeof rowProjectId === 'string' && projectId && rowProjectId !== projectId) {
        scoped = true
        continue
      }
      scopedRows.push(normalizeRow(row))
    }

    const truncated = scopedRows.length > HOST_QUERY_MAX_ROWS
    return {
      rows: truncated ? scopedRows.slice(0, HOST_QUERY_MAX_ROWS) : scopedRows,
      truncated,
      elapsedMs,
      scopedToProject: scoped || typeof projectId === 'string'
    }
  }
}

// Prisma returns BigInt for integer columns; JSON-serialize them to strings for the wire.
const normalizeRow = (row: Record<string, unknown>): HostQueryRow => {
  const out: HostQueryRow = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') {
      out[key] = value.toString()
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      out[key] = value
    } else if (value instanceof Date) {
      out[key] = value.toISOString()
    } else {
      out[key] = String(value)
    }
  }
  return out
}
