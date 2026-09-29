import type { ScreeningClient } from '../../src/main/references/screening-repository'

// An in-memory stand-in for the five Prisma delegates ScreeningRepository declares, with the ordering
// and filtering semantics the repository relies on (composite keys, `in` filters, orderBy, count).
// Shared by the service and IPC suites so both drive the REAL repository and the REAL engine over a
// ledger that behaves like the project database, instead of asserting against hand-written mocks.

type Row = Record<string, unknown>

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, expected]) => {
    if (expected !== null && typeof expected === 'object' && 'in' in (expected as Row)) {
      const list = (expected as { in: unknown[] }).in
      return list.includes(row[key])
    }
    return row[key] === expected
  })

const sorted = (rows: Row[], orderBy: Row | undefined): Row[] => {
  if (!orderBy) return rows
  const [[field, direction]] = Object.entries(orderBy)
  return [...rows].sort((left, right) => {
    const a = left[field] as number | string | Date
    const b = right[field] as number | string | Date
    const compare = a < b ? -1 : a > b ? 1 : 0
    return direction === 'desc' ? -compare : compare
  })
}

export const createInMemoryScreeningClient = (): ScreeningClient => {
  const ruleRevisions: Row[] = []
  const assessments: Row[] = []
  const overrides: Row[] = []
  const runs: Row[] = []
  const runItems: Row[] = []
  let runSeq = 0

  const keys = (where: Row): Row =>
    'collectionId_revision' in where
      ? (where.collectionId_revision as Row)
      : 'collectionId_referenceId' in where
        ? (where.collectionId_referenceId as Row)
        : 'runId_referenceId' in where
          ? (where.runId_referenceId as Row)
          : where

  return {
    screeningRuleRevision: {
      findUnique: async ({ where }: { where: Row }) => {
        const key = keys(where)
        return (
          ruleRevisions.find(
            (row) => row.collectionId === key.collectionId && row.revision === key.revision
          ) ?? null
        )
      },
      findFirst: async ({ where, orderBy }: { where: Row; orderBy?: Row }) =>
        sorted(
          ruleRevisions.filter((row) => matches(row, where)),
          orderBy
        )[0] ?? null,
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: Row }) =>
        sorted(
          ruleRevisions.filter((row) => matches(row, where)),
          orderBy
        ),
      create: async ({ data }: { data: Row }) => {
        const row = { createdAt: new Date(1710000000000 + ruleRevisions.length), ...data }
        ruleRevisions.push(row)
        return row
      }
    },
    screeningAssessment: {
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const key = keys(where)
        const existing = assessments.find(
          (row) => row.collectionId === key.collectionId && row.referenceId === key.referenceId
        )
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create }
        assessments.push(row)
        return row
      },
      findUnique: async ({ where }: { where: Row }) => {
        const key = keys(where)
        return (
          assessments.find(
            (row) => row.collectionId === key.collectionId && row.referenceId === key.referenceId
          ) ?? null
        )
      },
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: Row }) =>
        sorted(
          assessments.filter((row) => matches(row, where)),
          orderBy
        )
    },
    screeningOverride: {
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const key = keys(where)
        const existing = overrides.find(
          (row) => row.collectionId === key.collectionId && row.referenceId === key.referenceId
        )
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create }
        overrides.push(row)
        return row
      },
      findUnique: async ({ where }: { where: Row }) => {
        const key = keys(where)
        return (
          overrides.find(
            (row) => row.collectionId === key.collectionId && row.referenceId === key.referenceId
          ) ?? null
        )
      },
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: Row }) =>
        sorted(
          overrides.filter((row) => matches(row, where)),
          orderBy
        ),
      deleteMany: async ({ where }: { where: Row }) => {
        const doomed = overrides.filter((row) => matches(row, where))
        for (const row of doomed) overrides.splice(overrides.indexOf(row), 1)
        return { count: doomed.length }
      }
    },
    screeningRun: {
      create: async ({ data }: { data: Row }) => {
        runSeq += 1
        const row = {
          id: `run-${runSeq}`,
          startedAt: new Date(1710000000000 + runSeq),
          finishedAt: null,
          status: 'running',
          ...data
        }
        runs.push(row)
        return row
      },
      findUnique: async ({ where }: { where: Row }) =>
        runs.find((row) => row.id === where.id) ?? null,
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: Row }) =>
        sorted(
          runs.filter((row) => matches(row, where)),
          orderBy
        ),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = runs.find((candidate) => candidate.id === where.id)
        if (!row) throw new Error('run not found')
        Object.assign(row, data)
        return row
      }
    },
    screeningRunItem: {
      createMany: async ({ data }: { data: Row[] }) => {
        runItems.push(...data.map((row) => ({ ...row })))
        return { count: data.length }
      },
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const key = keys(where)
        const existing = runItems.find(
          (row) => row.runId === key.runId && row.referenceId === key.referenceId
        )
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create }
        runItems.push(row)
        return row
      },
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: Row }) =>
        sorted(
          runItems.filter((row) => matches(row, where)),
          orderBy
        ),
      count: async ({ where }: { where: Row }) =>
        runItems.filter((row) => matches(row, where)).length
    }
  } as unknown as ScreeningClient
}
