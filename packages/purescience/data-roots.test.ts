import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DATABASE_FILE, formatDataRoots, inspectDataRoot, inspectDataRoots } from './data-roots.mjs'
import { formatDoctor, runDoctor } from './doctor.mjs'

// What these tests hold the module to: a root reports only what was measured there. A root with no database
// reports no database (not 0 rows), a database this runtime cannot open reports why it was not measured, and a
// key whose bytes are not under the root is counted as exactly that rather than as a hit rate of zero.

const makeRoot = async (name = 'root'): Promise<string> => {
  const base = await mkdtemp(join(tmpdir(), 'purescience-roots-'))
  const root = join(base, name)
  await mkdir(root, { recursive: true })
  return root
}

type Row = { key: string; deleted?: boolean }

const makeDatabase = (root: string, rows: Row[]): string => {
  const path = join(root, DATABASE_FILE)
  const database = new DatabaseSync(path)
  database.exec(
    'CREATE TABLE "ManagedFile" ("id" TEXT PRIMARY KEY, "storageKey" TEXT NOT NULL, "deletedAt" INTEGER)'
  )
  const insert = database.prepare(
    'INSERT INTO "ManagedFile" ("id", "storageKey", "deletedAt") VALUES (?, ?, ?)'
  )
  rows.forEach((row, index) => {
    insert.run(`file-${String(index)}`, row.key, row.deleted === true ? 1 : null)
  })
  database.close()
  return path
}

const touchFile = async (root: string, key: string): Promise<void> => {
  const path = join(root, key)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'bytes', 'utf8')
}

describe('data roots', () => {
  it('reports a root with no database as no database, not as zero rows', async () => {
    const root = await makeRoot('empty')
    const entry = await inspectDataRoot({ root })

    expect(entry.measured).toBe('no-database')
    expect(entry.rows).toBeNull()
    expect(entry.sample).toBeNull()
    expect(String(entry.reason)).toContain('没有数据库')
    expect(entry.database.present).toBe(false)
  })

  it('measures live rows and how many sampled keys resolve under that root', async () => {
    const root = await makeRoot('prod')
    await touchFile(root, 'artifacts/p1/a/.provenance/run.json')
    await touchFile(root, 'artifacts/p1/b/.provenance/run.json')
    makeDatabase(root, [
      { key: 'artifacts/p1/a/.provenance/run.json' },
      { key: 'artifacts/p1/b/.provenance/run.json' },
      { key: 'artifacts/p1/c/.provenance/run.json' },
      { key: 'artifacts/p1/d/.provenance/run.json', deleted: true }
    ])

    const entry = await inspectDataRoot({ root })

    expect(entry.measured).toBe('rows')
    expect(entry.rows).toEqual({ total: 4, live: 3 })
    // The deleted row is neither counted as live nor sampled as a key that should resolve.
    expect(entry.sample).toEqual({ size: 3, resolved: 2, missing: 1, outsideRoot: 0 })
    expect(typeof entry.database.bytes).toBe('number')
    expect(typeof entry.database.lastWriteAt).toBe('string')
  })

  it('names a key that points outside the root instead of blaming the root for it', async () => {
    const root = await makeRoot('dev')
    makeDatabase(root, [{ key: '../elsewhere/run.json' }, { key: '/var/tmp/elsewhere/run.json' }])

    const entry = await inspectDataRoot({ root })

    expect(entry.measured).toBe('rows')
    expect(entry.sample).toEqual({ size: 2, resolved: 0, missing: 0, outsideRoot: 2 })
  })

  it('reports a database it cannot open as not measured, with the reason', async () => {
    const root = await makeRoot('broken')
    await writeFile(join(root, DATABASE_FILE), 'this is not a database', 'utf8')

    const entry = await inspectDataRoot({ root })

    expect(entry.measured).toBe('not-measured')
    expect(entry.rows).toBeNull()
    expect(String(entry.reason).length).toBeGreaterThan(0)
  })

  it('reports an unavailable database reader as not measured rather than as an empty root', async () => {
    const root = await makeRoot('unreadable')
    makeDatabase(root, [{ key: 'artifacts/p1/a/.provenance/run.json' }])

    const entry = await inspectDataRoot({
      root,
      loadDatabase: async () => {
        throw new Error('node:sqlite is not available on this runtime')
      }
    })

    expect(entry.measured).toBe('not-measured')
    expect(String(entry.reason)).toContain('node:sqlite')
    expect(entry.database.present).toBe(true)
  })
})

describe('purescience doctor — data roots', () => {
  it('reports both roots and which of them resolves its own rows', async () => {
    const dev = await makeRoot('dev-root')
    const prod = await makeRoot('prod-root')
    await touchFile(prod, 'artifacts/p1/a/.provenance/run.json')
    makeDatabase(prod, [{ key: 'artifacts/p1/a/.provenance/run.json' }])

    const report = await runDoctor({
      configRoot: prod,
      appPath: '/nonexistent/purescience',
      env: {},
      roots: [
        { root: dev, kind: 'dev' },
        { root: prod, kind: 'prod' }
      ]
    })
    const rootsCheck = report.checks.find((entry) => entry.check === 'data_roots')

    expect(report.dataRoots).toHaveLength(2)
    expect(rootsCheck?.status).toBe('ok')
    expect(rootsCheck?.evidence.roots).toBe(2)
    expect(rootsCheck?.evidence.measured).toBe(1)

    const formatted = formatDoctor(report)
    expect(formatted).toContain('data roots (2):')
    expect(formatted).toContain(dev)
    expect(formatted).toContain(prod)
    expect(formatted).toContain('resolvable=1/1')
    expect(formatted).toContain('no database')
    // The one sentence a reader needs in order not to compare two different roots by accident.
    expect(formatted).toContain('未打包的 CLI 默认读 dev 根')
  })

  it('warns when rows exist but their bytes are not under that root', async () => {
    const prod = await makeRoot('prod-root')
    makeDatabase(prod, [{ key: 'artifacts/p1/missing/.provenance/run.json' }])

    const report = await runDoctor({
      configRoot: prod,
      appPath: '/nonexistent/purescience',
      env: {},
      roots: [{ root: prod, kind: 'prod' }]
    })
    const rootsCheck = report.checks.find((entry) => entry.check === 'data_roots')

    expect(rootsCheck?.status).toBe('warn')
    expect(rootsCheck?.evidence.unresolved).toBe('prod:0/1')
    expect(String(rootsCheck?.evidence.detail)).toContain('找不到字节')
    // A warning, never a silent zero: the rate is printed for the reader to see.
    expect(formatDataRoots(report.dataRoots)).toContain('resolvable=0/1')
  })

  it('says the reading is missing when no root has a database, rather than reporting 0', async () => {
    const dev = await makeRoot('dev-root')
    const report = await runDoctor({
      configRoot: dev,
      appPath: '/nonexistent/purescience',
      env: {},
      roots: [{ root: dev, kind: 'dev' }]
    })
    const rootsCheck = report.checks.find((entry) => entry.check === 'data_roots')

    expect(rootsCheck?.status).toBe('warn')
    expect(rootsCheck?.evidence.measured).toBe(0)
    expect(String(rootsCheck?.evidence.detail)).toContain('没有读数')
    expect(JSON.stringify(rootsCheck?.evidence)).not.toContain('"rows":0')
  })

  it('measures only the root it was told to look at', async () => {
    const root = await makeRoot('only')
    makeDatabase(root, [])
    const entries = await inspectDataRoots({ configRoot: root })

    expect(entries).toHaveLength(1)
    expect(entries[0].root).toBe(root)
    expect(entries[0].measured).toBe('rows')
    expect(entries[0].rows).toEqual({ total: 0, live: null })
    expect(entries[0].sample).toEqual({ size: 0, resolved: 0, missing: 0, outsideRoot: 0 })
  })
})
