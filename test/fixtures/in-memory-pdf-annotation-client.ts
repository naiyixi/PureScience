import type {
  PdfAnnotationClient,
  StoredPdfAnnotationImportRow,
  StoredPdfAnnotationRow
} from '../../src/main/references/pdf-annotation-repository'

// An in-memory stand-in for the two Prisma delegates the PDF annotation repository declares, so the
// import channel can be driven against the REAL repository (and the real parser) without a database
// file. It ENFORCES the unique import key and returns the rows it holds, which is what makes
// "importing the same file twice stores one receipt" an assertion about behaviour rather than a
// restatement of the code: were the import path to skip its lookup, the second write would throw here
// exactly as SQLite would refuse it.
//
// The same fake lives inside pdf-annotation-repository.test.ts for that file's own rules; this copy is
// shared so the import suite does not have to reach into another suite's internals.

type Row = Record<string, unknown>

const matches = (row: Row, where: Row | undefined): boolean => {
  if (!where) return true
  // `OR` is the one combinator the repository uses (a multi-anchor read: "any of these file versions").
  // It is honoured rather than ignored: a fake that dropped it would answer a multi-anchor query with the
  // whole table, which is the failure mode the real query exists to avoid.
  const or = Array.isArray(where.OR) ? (where.OR as Row[]) : undefined
  if (or && !or.some((clause) => matches(row, clause))) return false

  return Object.entries(where)
    .filter(([key]) => key !== 'OR')
    .every(([key, value]) => row[key] === value)
}

const orderOf = (orderBy: unknown): Array<[string, 'asc' | 'desc']> =>
  (Array.isArray(orderBy) ? orderBy : [orderBy ?? {}]).map((entry) => {
    const [field, direction] = Object.entries(entry as Row)[0] as [string, 'asc' | 'desc']
    return [field, direction]
  })

const sortRows = (rows: Row[], orderBy: unknown): Row[] => {
  const comparators = orderOf(orderBy)
  if (comparators.length === 0) return [...rows]
  return [...rows].sort((left, right) => {
    for (const [field, direction] of comparators) {
      const a = left[field]
      const b = right[field]
      const leftValue = a instanceof Date ? a.getTime() : a
      const rightValue = b instanceof Date ? b.getTime() : b
      if (leftValue === rightValue) continue
      const order = (leftValue as number | string) < (rightValue as number | string) ? -1 : 1
      return direction === 'desc' ? -order : order
    }
    return 0
  })
}

export type InMemoryPdfAnnotationStore = {
  client: PdfAnnotationClient
  annotations: StoredPdfAnnotationRow[]
  imports: StoredPdfAnnotationImportRow[]
}

type FakeDelegate = {
  findMany: (args: {
    where?: Row
    orderBy?: unknown
    select?: Row
    take?: number
  }) => Promise<Row[]>
  findUnique: (args: { where: Row }) => Promise<Row | null>
  create: (args: { data: Row }) => Promise<Row>
  deleteMany: (args: { where?: Row }) => Promise<{ count: number }>
  count: (args: { where?: Row }) => Promise<number>
}

export const createInMemoryPdfAnnotationStore = (): InMemoryPdfAnnotationStore => {
  const annotations: StoredPdfAnnotationRow[] = []
  const imports: StoredPdfAnnotationImportRow[] = []
  let sequence = 0

  const delegate = <T extends Row>(
    rows: T[],
    prefix: string,
    defaults: () => Row,
    uniqueFields: string[]
  ): FakeDelegate => ({
    findMany: async ({
      where,
      orderBy,
      select,
      take
    }: {
      where?: Row
      orderBy?: unknown
      select?: Row
      take?: number
    }) => {
      const matched = sortRows(
        rows.filter((row) => matches(row, where)),
        orderBy
      )
      // `take` is honoured: a bounded read that the fake ignored would make "the bound was reached"
      // untestable, which is the one thing the bound exists to make checkable.
      const limited = typeof take === 'number' ? matched.slice(0, Math.max(0, take)) : matched

      return limited.map((row): Row =>
        select ? Object.fromEntries(Object.keys(select).map((field) => [field, row[field]])) : row
      )
    },
    findUnique: async ({ where }: { where: Row }) => {
      const compound = (where.sourceKind_sourceFileId_versionId_digest ?? where) as Row
      const found = rows.find((row) =>
        'sourceKind' in compound ? matches(row, compound) : row.id === compound.id
      )
      return found ?? null
    },
    create: async ({ data }: { data: Row }) => {
      const keyFields = uniqueFields.map((field) => [field, data[field]] as const)
      const conflict = rows.some((row) => keyFields.every(([field, value]) => row[field] === value))
      if (conflict) throw new Error('UNIQUE constraint failed')
      const row = {
        ...defaults(),
        ...data,
        id: (data.id as string) ?? `${prefix}-${++sequence}`
      } as unknown as T
      rows.push(row)
      return row as Row
    },
    deleteMany: async ({ where }: { where?: Row }) => {
      const keep = rows.filter((row) => !matches(row, where))
      const count = rows.length - keep.length
      rows.length = 0
      rows.push(...keep)
      return { count }
    },
    count: async ({ where }: { where?: Row }) => rows.filter((row) => matches(row, where)).length
  })

  const client = {
    pdfAnnotation: delegate(
      annotations,
      'annotation',
      () => ({ body: '', createdAt: new Date() }),
      ['id']
    ),
    pdfAnnotationImport: delegate(imports, 'import', () => ({ importedAt: new Date() }), [
      'sourceKind',
      'sourceFileId',
      'versionId',
      'digest'
    ])
  } as unknown as PdfAnnotationClient

  return { client, annotations, imports }
}
