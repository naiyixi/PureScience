import { describe, expect, it } from 'vitest'

import type { PdfAnnotationSelector } from '../../shared/pdf-annotations'
import {
  PdfAnnotationRepository,
  mapPdfAnnotation,
  type PdfAnnotationClient,
  type StoredPdfAnnotationImportRow,
  type StoredPdfAnnotationRow
} from './pdf-annotation-repository'

// The repository's own rules are what this suite asserts (the engine's behaviour is covered by the
// real-SQLite schema tests in src/main/projects/prisma-client.test.ts), so the client is a small
// in-memory stand-in rather than a mock of call arguments. It ENFORCES the unique import key, which is
// what makes "importing the same digest twice records one receipt" a real assertion instead of a
// restatement of the code: were the repository to skip its lookup, the second import would throw here
// exactly as it would against the real index.

type Row = Record<string, unknown>
type Where = Record<string, unknown>

const matches = (row: Row, where: Where | undefined): boolean => {
  if (!where) return true
  // `OR` is the one combinator the repository uses, for a multi-anchor read (A5's search corpus). Honoured
  // rather than ignored: a fake that dropped it would answer "any of these file versions" with the whole
  // table, which is the failure the real query exists to avoid.
  const or = Array.isArray(where.OR) ? (where.OR as Where[]) : undefined
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

const project = (row: Row, select: Row | undefined): Row => {
  if (!select) return row
  return Object.fromEntries(Object.keys(select).map((field) => [field, row[field]]))
}

type FakeDelegate = {
  findMany: (args: {
    where?: Where
    orderBy?: unknown
    select?: Row
    take?: number
  }) => Promise<Row[]>
  findUnique: (args: { where: Where }) => Promise<Row | null>
  create: (args: { data: Row }) => Promise<Row>
  update: () => Promise<never>
  deleteMany: (args: { where?: Where }) => Promise<{ count: number }>
  count: (args: { where?: Where }) => Promise<number>
}

const createFakeClient = (): {
  client: PdfAnnotationClient
  annotations: StoredPdfAnnotationRow[]
  imports: StoredPdfAnnotationImportRow[]
} => {
  const annotations: StoredPdfAnnotationRow[] = []
  const imports: StoredPdfAnnotationImportRow[] = []
  let sequence = 0
  const nextId = (prefix: string): string => `${prefix}-${++sequence}`

  const delegate = (
    rows: Row[],
    prefix: string,
    uniqueFields: string[],
    createDefaults: (data: Row) => Row
  ): FakeDelegate => ({
    findMany: ({
      where,
      orderBy,
      select,
      take
    }: {
      where?: Where
      orderBy?: unknown
      select?: Row
      take?: number
    }) => {
      const ordered = sortRows(
        rows.filter((row) => matches(row, where)),
        orderBy
      )
      // `take` is honoured: a bounded read the fake ignored would make "the bound was reached" untestable,
      // which is the one thing the bound exists to make checkable.
      const limited = typeof take === 'number' ? ordered.slice(0, Math.max(0, take)) : ordered
      return Promise.resolve(limited.map((row) => project(row, select)))
    },
    findUnique: ({ where }: { where: Where }) => {
      const compoundKey = where.sourceKind_sourceFileId_versionId_digest as Where | undefined
      const found = rows.find((row) =>
        compoundKey ? matches(row, compoundKey) : row.id === where.id
      )
      return Promise.resolve(found ?? null)
    },
    create: ({ data }: { data: Row }) => {
      // The real unique index, enforced: a duplicate idempotency key fails here exactly as SQLite
      // would refuse it, so a test observing one row proves the repository's own dedup, not a mock's
      // indifference.
      const keyFields = uniqueFields.map((field) => [field, data[field]] as const)
      const conflict = rows.some((row) => keyFields.every(([field, value]) => row[field] === value))
      if (conflict) return Promise.reject(new Error('UNIQUE constraint failed'))
      const row = { ...createDefaults(data), ...data }
      row.id = data.id ?? nextId(prefix)
      rows.push(row)
      return Promise.resolve(row)
    },
    update: () => Promise.reject(new Error('not used')),
    deleteMany: ({ where }: { where?: Where }) => {
      const keep = rows.filter((row) => !matches(row, where))
      const count = rows.length - keep.length
      rows.length = 0
      rows.push(...keep)
      return Promise.resolve({ count })
    },
    count: ({ where }: { where?: Where }) =>
      Promise.resolve(rows.filter((row) => matches(row, where)).length)
  })

  const client = {
    pdfAnnotation: delegate(annotations, 'annotation', ['id'], () => ({
      body: '',
      createdAt: new Date()
    })),
    pdfAnnotationImport: delegate(
      imports,
      'import',
      ['sourceKind', 'sourceFileId', 'versionId', 'digest'],
      () => ({ importedAt: new Date() })
    )
  } as unknown as PdfAnnotationClient

  return { client, annotations, imports }
}

const repositoryFor = (client: PdfAnnotationClient): PdfAnnotationRepository =>
  new PdfAnnotationRepository(() => Promise.resolve(client))

const textRangeSelector: PdfAnnotationSelector = {
  version: 1,
  shape: 'text-range',
  page: 3,
  rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
  quote: 'the passage that was marked'
}

const anchor = { sourceFileId: 'file-1', versionId: 'version-2', checksum: 'a'.repeat(64) }

const storedAnnotation = (
  overrides: Partial<StoredPdfAnnotationRow> = {}
): StoredPdfAnnotationRow => ({
  id: 'annotation-1',
  sourceFileId: 'file-1',
  versionId: 'version-2',
  checksum: 'a'.repeat(64),
  kind: 'highlight',
  selectorJson: JSON.stringify(textRangeSelector),
  body: '',
  createdAt: new Date(1710000000000),
  ...overrides
})

describe('PdfAnnotationRepository annotations are anchored to one file version', () => {
  it('writes the anchor together with the selector envelope', async () => {
    const { client, annotations } = createFakeClient()
    const repository = repositoryFor(client)

    const created = await repository.createAnnotation({
      ...anchor,
      sourceFileId: ' file-1 ',
      versionId: ' version-2 ',
      kind: 'highlight',
      selector: textRangeSelector
    })

    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({
      sourceFileId: 'file-1',
      versionId: 'version-2',
      checksum: 'a'.repeat(64),
      kind: 'highlight',
      body: ''
    })
    expect(JSON.parse(annotations[0]!.selectorJson)).toEqual(textRangeSelector)
    expect(created).toMatchObject({ sourceFileId: 'file-1', versionId: 'version-2', body: '' })
    expect(created.selector).toEqual(textRangeSelector)
    expect(created.createdAt).toBeGreaterThan(0)
  })

  it('refuses a kind/selector disagreement and stores nothing', async () => {
    const { client, annotations } = createFakeClient()
    const repository = repositoryFor(client)

    await expect(
      repository.createAnnotation({
        ...anchor,
        kind: 'area',
        selector: textRangeSelector
      })
    ).rejects.toThrow(
      'PDF annotation refused (selector-shape-mismatch): kind "area" needs selector shape "area", but the selector declares shape "text-range".'
    )
    expect(annotations).toEqual([])

    await expect(
      repository.createAnnotation({
        ...anchor,
        kind: 'highlight',
        selector: { ...textRangeSelector, quote: '' }
      })
    ).rejects.toThrow(/"quote"/)
    await expect(
      repository.createAnnotation({ ...anchor, kind: 'blob', selector: textRangeSelector })
    ).rejects.toThrow(/unknown-kind/)
    expect(annotations).toEqual([])
  })

  it('refuses a write that names no version or no content checksum', async () => {
    const { client, annotations } = createFakeClient()
    const repository = repositoryFor(client)

    await expect(
      repository.createAnnotation({
        ...anchor,
        versionId: '  ',
        kind: 'highlight',
        selector: textRangeSelector
      })
    ).rejects.toThrow(/versionId/)
    await expect(
      repository.createAnnotation({
        ...anchor,
        checksum: '',
        kind: 'highlight',
        selector: textRangeSelector
      })
    ).rejects.toThrow(/content checksum/)
    await expect(
      repository.createAnnotation({
        ...anchor,
        sourceFileId: '',
        kind: 'highlight',
        selector: textRangeSelector
      })
    ).rejects.toThrow(/sourceFileId/)
    expect(annotations).toEqual([])
  })

  it('reads one version and never another, oldest first', async () => {
    const { client, annotations } = createFakeClient()
    annotations.push(
      storedAnnotation({ id: 'annotation-late', createdAt: new Date(20) }),
      storedAnnotation({ id: 'annotation-early', createdAt: new Date(10) }),
      storedAnnotation({ id: 'annotation-v1', versionId: 'version-1' }),
      storedAnnotation({ id: 'annotation-other-file', sourceFileId: 'file-2' })
    )
    const repository = repositoryFor(client)

    const listed = await repository.listAnnotations({
      sourceFileId: 'file-1',
      versionId: 'version-2'
    })
    expect(listed.map((annotation) => annotation.id)).toEqual([
      'annotation-early',
      'annotation-late'
    ])
    expect(
      await repository.countAnnotations({ sourceFileId: 'file-1', versionId: 'version-1' })
    ).toBe(1)
    // The other version's annotations are not "the same file's annotations": nothing is migrated.
    expect(
      (await repository.listAnnotations({ sourceFileId: 'file-1', versionId: 'version-9' })).map(
        (annotation) => annotation.id
      )
    ).toEqual([])
    await expect(
      repository.listAnnotations({ sourceFileId: 'file-1', versionId: '' })
    ).rejects.toThrow(/versionId/)
  })

  it('narrows a version read by kind', async () => {
    const { client, annotations } = createFakeClient()
    annotations.push(
      storedAnnotation({ id: 'annotation-hl' }),
      storedAnnotation({
        id: 'annotation-note',
        kind: 'page-note',
        selectorJson: JSON.stringify({ version: 1, shape: 'page-note', page: 3 }),
        body: 'look here'
      })
    )
    const repository = repositoryFor(client)

    const highlights = await repository.listAnnotations(
      { sourceFileId: 'file-1', versionId: 'version-2' },
      { kind: 'highlight' }
    )
    expect(highlights.map((annotation) => annotation.id)).toEqual(['annotation-hl'])
    expect(
      (await repository.listAnnotations({ sourceFileId: 'file-1', versionId: 'version-2' })).length
    ).toBe(2)
  })

  it('answers the version-switch question with the versions that carry annotations', async () => {
    const { client, annotations } = createFakeClient()
    annotations.push(
      storedAnnotation({ id: 'a', versionId: 'version-2' }),
      storedAnnotation({ id: 'b', versionId: 'version-1' }),
      storedAnnotation({ id: 'c', versionId: 'version-2' }),
      storedAnnotation({ id: 'd', sourceFileId: 'file-2', versionId: 'version-7' })
    )
    const repository = repositoryFor(client)

    expect(await repository.listAnnotatedVersions('file-1')).toEqual(['version-1', 'version-2'])
    expect(await repository.listAnnotatedVersions('file-3')).toEqual([])
    await expect(repository.listAnnotatedVersions('')).rejects.toThrow(/sourceFileId/)
  })

  it('refuses to read back a stored row whose kind and selector disagree', async () => {
    const { client, annotations } = createFakeClient()
    annotations.push(
      storedAnnotation({ id: 'annotation-broken', kind: 'area' }),
      storedAnnotation({ id: 'annotation-unknown-kind', kind: 'squiggle' })
    )
    const repository = repositoryFor(client)

    // Not relabelled into a kind it is not, and not returned as the kind the caller asked for: the row
    // is refused and named, so a writer outside this layer cannot plant an annotation that reads as
    // something else.
    await expect(repository.getAnnotation('annotation-broken')).rejects.toThrow(
      'Stored PDF annotation annotation-broken is inconsistent and cannot be read: kind "area" needs selector shape "area", but the selector declares shape "text-range".'
    )
    await expect(repository.getAnnotation('annotation-unknown-kind')).rejects.toThrow(
      /unknown-kind/
    )
    await expect(
      repository.listAnnotations({ sourceFileId: 'file-1', versionId: 'version-2' })
    ).rejects.toThrow(/annotation-broken/)
    await expect(repository.getAnnotation('annotation-missing')).resolves.toBeNull()
  })

  it('maps a stored row and clears annotations by version, file and entirely', async () => {
    const { client, annotations } = createFakeClient()
    annotations.push(
      storedAnnotation({ id: 'a' }),
      storedAnnotation({ id: 'a2' }),
      storedAnnotation({ id: 'b', versionId: 'version-1' }),
      storedAnnotation({ id: 'c', sourceFileId: 'file-2' })
    )
    const repository = repositoryFor(client)

    expect(mapPdfAnnotation(storedAnnotation()).selector).toEqual(textRangeSelector)
    expect(await repository.deleteAnnotation('a')).toBe(true)
    expect(await repository.deleteAnnotation('a')).toBe(false)
    expect(
      await repository.deleteAnnotationsForVersion({
        sourceFileId: 'file-1',
        versionId: 'version-1'
      })
    ).toBe(1)
    expect(await repository.deleteAnnotationsForFile('file-1')).toBe(1)
    expect(await repository.deleteAllAnnotations()).toBe(1)
    expect(annotations).toEqual([])
  })
})

describe('PdfAnnotationRepository import receipts are idempotent and independent', () => {
  it('records one receipt for a repeated import of the same payload into the same version', async () => {
    const { client, imports } = createFakeClient()
    const repository = repositoryFor(client)
    const input = { ...anchor, sourceKind: 'embedded-pdf', digest: 'd'.repeat(64) }

    const first = await repository.recordImport({ ...input, importedAt: 1710000000000 })
    const second = await repository.recordImport({ ...input, importedAt: 1720000000000 })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(imports).toHaveLength(1)
    // The receipt keeps the time of the import that actually happened.
    expect(second.record.id).toBe(first.record.id)
    expect(second.record.importedAt).toBe(1710000000000)
    expect(await repository.listImports({ sourceFileId: 'file-1' })).toHaveLength(1)
  })

  it('keeps one receipt per version and per channel, so a shared payload is not swallowed', async () => {
    const { client, imports } = createFakeClient()
    const repository = repositoryFor(client)
    const digest = 'd'.repeat(64)

    await expect(
      repository.recordImport({ ...anchor, sourceKind: 'embedded-pdf', digest })
    ).resolves.toMatchObject({ created: true })
    // Same payload, another version: a different import, so it is owed its own receipt.
    await expect(
      repository.recordImport({
        ...anchor,
        versionId: 'version-3',
        sourceKind: 'embedded-pdf',
        digest
      })
    ).resolves.toMatchObject({ created: true })
    // Same payload and version, another channel: likewise its own receipt.
    await expect(
      repository.recordImport({ ...anchor, sourceKind: 'annotation-file', digest })
    ).resolves.toMatchObject({ created: true })

    expect(imports).toHaveLength(3)
    expect(
      await repository.listImports({ sourceFileId: 'file-1', versionId: 'version-2' })
    ).toHaveLength(2)
  })

  it('refuses an unknown channel, a missing digest and a missing version', async () => {
    const { client, imports } = createFakeClient()
    const repository = repositoryFor(client)

    await expect(
      repository.recordImport({ ...anchor, sourceKind: 'clipboard', digest: 'd' })
    ).rejects.toThrow(/unknown-source-kind/)
    await expect(
      repository.recordImport({ ...anchor, sourceKind: 'embedded-pdf', digest: ' ' })
    ).rejects.toThrow(/digest/)
    await expect(
      repository.recordImport({ ...anchor, versionId: '', sourceKind: 'embedded-pdf', digest: 'd' })
    ).rejects.toThrow(/versionId/)
    expect(imports).toEqual([])
  })

  it('clears annotations and receipts independently, in both directions', async () => {
    const { client, annotations, imports } = createFakeClient()
    const repository = repositoryFor(client)

    await repository.createAnnotation({ ...anchor, kind: 'highlight', selector: textRangeSelector })
    await repository.recordImport({ ...anchor, sourceKind: 'embedded-pdf', digest: 'd'.repeat(64) })

    // Clearing the annotations leaves the receipt that recorded how they arrived.
    expect(
      await repository.deleteAnnotationsForVersion({
        sourceFileId: 'file-1',
        versionId: 'version-2'
      })
    ).toBe(1)
    expect(annotations).toEqual([])
    expect(imports).toHaveLength(1)
    expect(await repository.listImports({ sourceFileId: 'file-1' })).toHaveLength(1)

    // ...and dropping the receipt leaves the annotations exactly where they were.
    await repository.createAnnotation({ ...anchor, kind: 'highlight', selector: textRangeSelector })
    const [receipt] = await repository.listImports({})
    expect(await repository.deleteImport(receipt!.id)).toBe(true)
    expect(await repository.deleteImport(receipt!.id)).toBe(false)
    expect(imports).toEqual([])
    expect(
      await repository.countAnnotations({ sourceFileId: 'file-1', versionId: 'version-2' })
    ).toBe(1)

    // A whole-ledger clear on one side is still one side only.
    await repository.recordImport({ ...anchor, sourceKind: 'embedded-pdf', digest: 'e'.repeat(64) })
    expect(await repository.deleteAllImports()).toBe(1)
    expect(
      await repository.countAnnotations({ sourceFileId: 'file-1', versionId: 'version-2' })
    ).toBe(1)
    expect(
      await repository.deleteImportsForVersion({ sourceFileId: 'file-1', versionId: 'version-2' })
    ).toBe(0)
    expect(await repository.deleteAllAnnotations()).toBe(1)
  })

  it('reads one receipt by its idempotency key and lists receipts by version', async () => {
    const { client } = createFakeClient()
    const repository = repositoryFor(client)
    const input = { ...anchor, sourceKind: 'embedded-pdf' as const, digest: 'd'.repeat(64) }

    await expect(repository.getImport(input)).resolves.toBeNull()
    await repository.recordImport(input)
    await expect(repository.getImport(input)).resolves.toMatchObject({
      sourceKind: 'embedded-pdf',
      sourceFileId: 'file-1',
      versionId: 'version-2',
      digest: 'd'.repeat(64)
    })
    await expect(repository.getImport({ ...input, digest: 'f'.repeat(64) })).resolves.toBeNull()

    // The receipt created above keeps its own import time; these two are ordered by theirs.
    await repository.recordImport({ ...input, digest: 'e'.repeat(64), importedAt: 5 })
    await repository.recordImport({ ...input, digest: 'f'.repeat(64), importedAt: 1 })
    const listed = await repository.listImports({ sourceFileId: 'file-1', versionId: 'version-2' })
    expect(listed.map((receipt) => receipt.digest)).toEqual([
      'f'.repeat(64),
      'e'.repeat(64),
      'd'.repeat(64)
    ])
  })

  it('refuses to read back a stored receipt that names an unknown channel', async () => {
    const { client, imports } = createFakeClient()
    imports.push({
      id: 'import-1',
      sourceKind: 'clipboard',
      sourceFileId: 'file-1',
      versionId: 'version-2',
      importedAt: new Date(1),
      digest: 'd'
    })

    // A receipt that names no known channel is refused rather than reported with a channel it is not.
    await expect(repositoryFor(client).listImports({})).rejects.toThrow(/source kind "clipboard"/)
    // A lookup by a known channel simply does not match it.
    await expect(
      repositoryFor(client).getImport({ ...anchor, sourceKind: 'embedded-pdf', digest: 'd' })
    ).resolves.toBeNull()
  })
})

// The multi-anchor read the search corpus of a project is built from (A5). It answers one question — "the
// annotations of these file versions" — and the two properties that matter are that it is scoped to the
// anchors it was given and that it says when its bound was reached.
describe('PdfAnnotationRepository listAnnotationsForFileVersions', () => {
  it('answers with the annotations of the named anchors, and only those', async () => {
    const { client, annotations } = createFakeClient()
    annotations.push(
      storedAnnotation({ id: 'a-1', sourceFileId: 'file-1', versionId: 'version-2' }),
      storedAnnotation({ id: 'a-2', sourceFileId: 'file-2', versionId: 'version-5' }),
      // The same file on another version: not one of the anchors, so it must not be swept in by file id.
      storedAnnotation({ id: 'a-3', sourceFileId: 'file-1', versionId: 'version-1' })
    )

    const read = await repositoryFor(client).listAnnotationsForFileVersions(
      [
        { sourceFileId: 'file-1', versionId: 'version-2' },
        { sourceFileId: 'file-2', versionId: 'version-5' }
      ],
      { limit: 10 }
    )

    expect(read.annotations.map((annotation) => annotation.id)).toEqual(['a-1', 'a-2'])
    expect(read.bounded).toBe(false)
  })

  it('answers an empty anchor list with nothing and no error', async () => {
    const { client, annotations } = createFakeClient()
    annotations.push(storedAnnotation())

    await expect(
      repositoryFor(client).listAnnotationsForFileVersions([], { limit: 10 })
    ).resolves.toEqual({ annotations: [], bounded: false })
  })

  it('reports the bound being reached rather than serving a short corpus as the whole library', async () => {
    const { client, annotations } = createFakeClient()
    annotations.push(
      storedAnnotation({ id: 'a-1' }),
      storedAnnotation({ id: 'a-2' }),
      storedAnnotation({ id: 'a-3' })
    )

    const read = await repositoryFor(client).listAnnotationsForFileVersions(
      [{ sourceFileId: 'file-1', versionId: 'version-2' }],
      { limit: 2 }
    )

    expect(read.annotations).toHaveLength(2)
    expect(read.bounded).toBe(true)
  })

  it('refuses an anchor that names no version, rather than reading the whole file', async () => {
    const { client } = createFakeClient()

    await expect(
      repositoryFor(client).listAnnotationsForFileVersions(
        [{ sourceFileId: 'file-1', versionId: ' ' }],
        { limit: 10 }
      )
    ).rejects.toThrow(/versionId is missing/)
  })

  it('refuses a stored row whose kind and selector disagree, on this read too', async () => {
    const { client, annotations } = createFakeClient()
    annotations.push(
      storedAnnotation({
        kind: 'area',
        selectorJson: JSON.stringify(textRangeSelector)
      })
    )

    await expect(
      repositoryFor(client).listAnnotationsForFileVersions(
        [{ sourceFileId: 'file-1', versionId: 'version-2' }],
        { limit: 10 }
      )
    ).rejects.toThrow(/inconsistent and cannot be read/)
  })
})
