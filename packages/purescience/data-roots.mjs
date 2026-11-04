/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { access, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import { candidateConfigRoots, DEV_CONFIG_DIR, PROD_CONFIG_DIR } from './config-root.mjs'

// What a data root is, and what this module refuses to guess about it.
//
// The application keeps its database and the bytes that database points at under one directory. On a machine
// where both a development build and a packaged build have run, there are two such directories, and a reader
// who looks at one while the numbers came from the other sees the shape that started this module: rows in a
// table, no files on disk. Nothing is missing in that case — the question was asked of the wrong root.
//
// So this reports, per root, exactly three measured things: whether a database is there and how big it is, how
// many `ManagedFile` rows it holds, and how many of a sample of those rows' `storageKey` values actually resolve
// underneath *that* root. A root with no database reports no database — not zero rows, not a hit rate of zero.
// A database this runtime cannot open reports that it was not measured, with the reason. Absence of a
// measurement is never rendered as a measurement of zero.

export const DATABASE_FILE = 'purescience.db'

/** How many `storageKey` values are sampled per root. Enough to tell "resolves" from "does not", cheap to run. */
export const SAMPLE_SIZE = 20

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const kindOf = (root) => {
  const name = basename(root)
  if (name === DEV_CONFIG_DIR) return 'dev'
  if (name === PROD_CONFIG_DIR) return 'prod'
  return 'custom'
}

const loadNodeSqlite = async () => {
  const module = await import('node:sqlite')
  return module.DatabaseSync
}

const readDatabase = async (loadDatabase, databasePath, root, sampleSize) => {
  // The injected loader is awaited here so the "reader unavailable" branch is a named failure rather than a
  // constructor call on a function.

  const DatabaseSync = await loadDatabase()
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const totals = database
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN "deletedAt" IS NULL THEN 1 ELSE 0 END) AS live
           FROM "ManagedFile"`
      )
      .get()
    // `SUM` over zero live rows is NULL, and NULL is the honest answer for "no live rows" — it must not be
    // smoothed into 0, which a reader would take as "the query ran and found none deleted".
    const live =
      totals && totals.live !== null && totals.live !== undefined ? Number(totals.live) : null
    const rows = { total: Number(totals ? totals.total : 0), live }

    const sampled = database
      .prepare(
        `SELECT "storageKey" AS key
           FROM "ManagedFile"
          WHERE "deletedAt" IS NULL
          ORDER BY rowid DESC
          LIMIT ?`
      )
      .all(sampleSize)
    const keys = sampled.map((row) => String(row.key ?? ''))

    let resolved = 0
    let outsideRoot = 0
    for (const key of keys) {
      // A key that is absolute, or that climbs out of the root, is not "missing" — it points somewhere this
      // root does not own. Counting it as missing would blame the root for a row that never referred to it.
      if (isAbsolute(key) || key.split(/[\\/]/).includes('..')) {
        outsideRoot += 1
        continue
      }
      if (await exists(join(root, key))) resolved += 1
    }

    return {
      measured: 'rows',
      rows,
      sample: {
        size: keys.length,
        resolved,
        missing: keys.length - resolved - outsideRoot,
        outsideRoot
      }
    }
  } finally {
    // Closing is not decoration: the packaged application may be running and holding the same file, and a
    // reader that leaves the handle open keeps a lock it has no use for.
    database.close()
  }
}

export const inspectDataRoot = async ({
  root,
  kind = kindOf(root),
  sampleSize = SAMPLE_SIZE,
  loadDatabase = loadNodeSqlite
}) => {
  const entry = { root, kind }
  if (!(await exists(root))) {
    return {
      ...entry,
      exists: false,
      database: { path: join(root, DATABASE_FILE), present: false },
      measured: 'no-database',
      rows: null,
      sample: null,
      reason: '这个根还不存在'
    }
  }

  const databasePath = join(root, DATABASE_FILE)
  if (!(await exists(databasePath))) {
    // The root can exist without a database (a config root that only ever held settings). Saying "0 rows" here
    // would be a measurement of something that was never there.
    return {
      ...entry,
      exists: true,
      database: { path: databasePath, present: false },
      measured: 'no-database',
      rows: null,
      sample: null,
      reason: '这个根里没有数据库文件'
    }
  }

  let bytes
  let lastWriteAt
  try {
    const info = await stat(databasePath)
    bytes = info.size
    lastWriteAt = new Date(info.mtimeMs).toISOString()
  } catch {
    bytes = undefined
  }

  const database = {
    path: databasePath,
    present: true,
    ...(bytes === undefined ? {} : { bytes }),
    ...(lastWriteAt === undefined ? {} : { lastWriteAt })
  }

  try {
    const measured = await readDatabase(loadDatabase, databasePath, root, sampleSize)
    return { ...entry, exists: true, database, ...measured }
  } catch (error) {
    return {
      ...entry,
      exists: true,
      database,
      measured: 'not-measured',
      rows: null,
      sample: null,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Every root this machine has, in the order the CLI itself would consider them.
 *
 * `roots` is an injection seam for tests (a test must never read the machine's real roots). Without it, an
 * explicit `configRoot` wins — that is what the caller asked this process to look at — and otherwise both
 * candidates are reported, dev first, because that is the order `resolveConfigRoot` picks from.
 */
export const inspectDataRoots = async ({
  configRoot,
  env = process.env,
  roots,
  sampleSize = SAMPLE_SIZE,
  loadDatabase = loadNodeSqlite
} = {}) => {
  const targets =
    roots ??
    (configRoot ? [configRoot] : candidateConfigRoots({ env })).map((root) => ({
      root,
      kind: kindOf(root)
    }))

  const inspected = []
  for (const target of targets) {
    inspected.push(await inspectDataRoot({ ...target, sampleSize, loadDatabase }))
  }
  return inspected
}

const formatBytes = (bytes) => {
  if (typeof bytes !== 'number') return 'size=unknown'
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const describeRoot = (entry) => {
  const where = `${entry.kind.padEnd(4)} ${entry.root}`
  if (entry.measured === 'no-database') {
    return `${where}  no database (${String(entry.reason)})`
  }
  if (entry.measured === 'not-measured') {
    return `${where}  not measured (${String(entry.reason)})`
  }
  const database = entry.database
  const rows = entry.rows
  const sample = entry.sample
  const parts = [
    `db=${formatBytes(database.bytes)}`,
    `rows=${String(rows.total)}`,
    `live=${String(rows.live)}`,
    sample && sample.size > 0
      ? `resolvable=${String(sample.resolved)}/${String(sample.size)}`
      : 'resolvable=not sampled',
    database.lastWriteAt ? `last write=${database.lastWriteAt.slice(0, 19)}Z` : 'last write=unknown'
  ]
  if (sample && sample.outsideRoot > 0) parts.push(`outside-root=${String(sample.outsideRoot)}`)
  return `${where}  ${parts.join('  ')}`
}

/**
 * The paragraph under the per-root lines. It states the one fact that made this module necessary, and it is
 * written as a property of the two builds rather than of this machine, because that is what it is.
 */
export const DATA_ROOT_NOTE =
  '未打包的 CLI 默认读 dev 根，打包后的应用读 prod 根；命中率是抽样出来的：那一根里的 storageKey 有几个能在同一根下找到字节。'

export const formatDataRoots = (roots) => {
  const lines = [`data roots (${String(roots.length)}):`]
  for (const entry of roots) lines.push(`  ${describeRoot(entry)}`)
  lines.push(`  ${DATA_ROOT_NOTE}`)
  return lines.join('\n')
}

// Exported so a caller can say "this machine has two roots" without re-deriving it from path names.
export const summariseDataRoots = (roots) => ({
  roots: roots.length,
  withDatabase: roots.filter((entry) => entry.database && entry.database.present).length,
  measured: roots.filter((entry) => entry.measured === 'rows').length
})
