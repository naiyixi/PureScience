import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  countPurgeRecords,
  judgeCacheDirResolution,
  judgeOrphanRemovalRecord,
  judgePurgeRecord,
  logDirectoriesForLogFile,
  readAppUpdateCacheRecords,
  selectHandoffRecord,
  selectOrphanRecord,
  selectPurgeRecord
} from './macos-update-cache-drill.mjs'

// One record exactly as the app writes it (src/main/logger.ts: one JSON object per line), taken from
// a real packaged launch rather than invented, so the reader is pinned to the shape it must parse.
const purgeRecord = ({
  cacheDir,
  installedVersion,
  removedBytes,
  removedFiles = 3
}: {
  cacheDir: string
  installedVersion: string
  removedBytes: number
  removedFiles?: number
}): string =>
  JSON.stringify({
    t: '2026-11-18T03:41:23.606Z',
    level: 'info',
    scope: 'update',
    msg: 'update cache: purged after a completed install',
    runId: '0ad97d75-7481-4a97-b70e-1815de4a602b',
    data: { cacheDir, installedVersion, removedFiles, removedBytes }
  })

const pendingRecord = (cacheDir: string, version: string): string =>
  JSON.stringify({
    t: '2026-11-18T03:41:11.688Z',
    level: 'info',
    scope: 'update',
    msg: 'update cache: recorded the pending install',
    data: { version, cacheDir }
  })

const writeLog = async (lines: string[]): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'purescience-drill-logs-'))
  await writeFile(join(directory, 'main.log'), `${lines.join('\n')}\n`, 'utf8')
  return directory
}

const CACHE_DIR = '/Users/runner/Library/Caches/purescience-updater'

describe('reading the app own update-cache records', () => {
  it('parses the JSON lines and keeps only update-cache records', async () => {
    const directory = await writeLog([
      JSON.stringify({ msg: 'acp: prompt start', scope: 'acp', data: { sessionId: 's1' } }),
      pendingRecord(CACHE_DIR, '2.30.2'),
      'a half-written line the app was still flushing',
      purgeRecord({ cacheDir: CACHE_DIR, installedVersion: '2.31.0', removedBytes: 590843729 })
    ])

    const records = await readAppUpdateCacheRecords({
      home: '/nonexistent',
      directories: [directory]
    })

    expect(records.map((record) => record.msg)).toEqual([
      'update cache: recorded the pending install',
      'update cache: purged after a completed install'
    ])
    expect(records[1].data).toMatchObject({
      cacheDir: CACHE_DIR,
      installedVersion: '2.31.0',
      removedBytes: 590843729
    })
  })

  it('returns nothing when the log directory does not exist', async () => {
    const records = await readAppUpdateCacheRecords({
      home: '/nonexistent',
      directories: [join(tmpdir(), 'purescience-drill-no-such-log-dir')]
    })

    expect(records).toEqual([])
  })

  it('still finds a record a whole launch of lines has pushed back', async () => {
    // A launch writes hundreds of lines; a record written early in it must not fall out of the tail
    // the reader parses. At a 400-line window this drill reported "no orphan record" while the app
    // had recorded it, so the bound itself is pinned here.
    const noise = Array.from({ length: 1_000 }, (_, index) =>
      JSON.stringify({ msg: `renderer: line ${index}`, scope: 'renderer', data: {} })
    )
    const directory = await writeLog([
      purgeRecord({ cacheDir: CACHE_DIR, installedVersion: '2.31.0', removedBytes: 590843729 }),
      ...noise
    ])

    const records = await readAppUpdateCacheRecords({
      home: '/nonexistent',
      directories: [directory]
    })

    expect(selectPurgeRecord({ records, cacheDir: CACHE_DIR })?.data).toMatchObject({
      removedBytes: 590843729
    })
  })
})

describe('selecting the record that speaks for this purge', () => {
  it('takes the newest record for the directory, not a pending install nor another cache', async () => {
    const directory = await writeLog([
      pendingRecord(CACHE_DIR, '2.31.0'),
      purgeRecord({ cacheDir: CACHE_DIR, installedVersion: '2.31.0', removedBytes: 100 }),
      purgeRecord({
        cacheDir: '/tmp/another-cache',
        installedVersion: '2.31.0',
        removedBytes: 999
      }),
      purgeRecord({ cacheDir: CACHE_DIR, installedVersion: '2.31.0', removedBytes: 590843729 })
    ])

    const records = await readAppUpdateCacheRecords({
      home: '/nonexistent',
      directories: [directory]
    })
    const selected = selectPurgeRecord({ records, cacheDir: CACHE_DIR })

    expect(selected?.data?.removedBytes).toBe(590843729)
  })
})

describe('judging the app record against what the drill watched', () => {
  const readRecords = async (lines: string[]): Promise<unknown[]> => {
    const directory = await writeLog(lines)
    return readAppUpdateCacheRecords({ home: '/nonexistent', directories: [directory] })
  }

  const judge = (
    records: unknown[],
    expectedBytes = 590843729
  ): ReturnType<typeof judgePurgeRecord> =>
    judgePurgeRecord({
      record: selectPurgeRecord({ records, cacheDir: CACHE_DIR }),
      records,
      cacheDir: CACHE_DIR,
      expectedBytes,
      expectedVersion: '2.31.0'
    })

  it('passes on the app own purge of exactly the bytes the drill counted', async () => {
    const records = await readRecords([
      purgeRecord({ cacheDir: CACHE_DIR, installedVersion: '2.31.0', removedBytes: 590843729 })
    ])

    const verdict = judge(records)

    expect(verdict.ok).toBe(true)
    expect(verdict.summary).toContain('590843729 bytes')
    expect(verdict.summary).toContain(CACHE_DIR)
    expect(verdict.evidence.matched).toMatchObject({ removedFiles: 3, installedVersion: '2.31.0' })
  })

  it('refuses to call an empty directory a purge when the app recorded none', async () => {
    const records = await readRecords([pendingRecord(CACHE_DIR, '2.31.0')])

    const verdict = judge(records)

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('an empty directory is not proof')
    expect(verdict.evidence.purgeRecordsSeen).toEqual([])
  })

  it('names the directory the app actually purged when it is not the one under test', async () => {
    const records = await readRecords([
      purgeRecord({
        cacheDir: '/Users/runner/Library/Caches/other',
        installedVersion: '2.31.0',
        removedBytes: 590843729
      })
    ])

    const verdict = judge(records)

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('/Users/runner/Library/Caches/other')
  })

  it('fails when the app removed a different number of bytes than the drill counted', async () => {
    const records = await readRecords([
      purgeRecord({ cacheDir: CACHE_DIR, installedVersion: '2.31.0', removedBytes: 590843728 })
    ])

    const verdict = judge(records)

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('590843728')
    expect(verdict.reason).toContain('590843729')
  })

  it('fails when the purge belongs to another installed version', async () => {
    const records = await readRecords([
      purgeRecord({ cacheDir: CACHE_DIR, installedVersion: '2.30.2', removedBytes: 590843729 })
    ])

    const verdict = judge(records)

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('2.30.2')
  })
})

// The half of the cross-check that has to happen BEFORE the install: the app records which cache
// directory it resolved when it hands the package to the installer. Inside a packaged bundle that
// record is the only reading available — `require('electron-updater')` does not resolve there, so an
// "unavailable" probe result that nothing judged was the gap this pins shut.
describe('judging the cache directory the app resolved, before the install', () => {
  const readRecords = async (lines: string[]): Promise<unknown[]> => {
    const directory = await writeLog(lines)
    return readAppUpdateCacheRecords({ home: '/nonexistent', directories: [directory] })
  }

  const judge = (records: unknown[]): ReturnType<typeof judgeCacheDirResolution> =>
    judgeCacheDirResolution({
      record: selectHandoffRecord({ records, version: '2.31.1' }),
      records,
      cacheDir: CACHE_DIR,
      version: '2.31.1'
    })

  it('passes when the app recorded exactly the directory the drill watches', async () => {
    const records = await readRecords([pendingRecord(CACHE_DIR, '2.31.1')])

    const verdict = judge(records)

    expect(verdict.state).toBe('matched')
    expect(verdict.ok).toBe(true)
    expect(verdict.summary).toContain(CACHE_DIR)
    expect(verdict.evidence.matched).toMatchObject({ cacheDir: CACHE_DIR, version: '2.31.1' })
  })

  it('fails by name when the app resolved a different directory', async () => {
    const records = await readRecords([
      pendingRecord('/Users/runner/Library/Caches/other', '2.31.1')
    ])

    const verdict = judge(records)

    expect(verdict.ok).toBe(false)
    expect(verdict.state).toBe('mismatch')
    expect(verdict.reason).toContain('/Users/runner/Library/Caches/other')
    expect(verdict.reason).toContain(CACHE_DIR)
  })

  it('refuses to infer the directory when this version has no hand-off record', async () => {
    // A record for an earlier install says nothing about this one: without that distinction the drill
    // would attribute a purge it arranged to whichever directory it happened to be watching.
    const records = await readRecords([
      pendingRecord(CACHE_DIR, '2.30.2'),
      JSON.stringify({ msg: 'acp: prompt start', scope: 'acp', data: { sessionId: 's1' } })
    ])

    const verdict = judge(records)

    expect(verdict.ok).toBe(false)
    expect(verdict.state).toBe('unavailable')
    expect(verdict.reason).toContain('2.31.1')
    expect(verdict.reason).toContain('inferred')
    expect(verdict.evidence.handoffRecordsSeen).toEqual([
      { cacheDir: CACHE_DIR, version: '2.30.2' }
    ])
  })

  it('takes the newest hand-off record for the version being installed', async () => {
    const records = await readRecords([
      pendingRecord('/Users/runner/Library/Caches/stale', '2.31.1'),
      pendingRecord(CACHE_DIR, '2.31.1')
    ])

    const verdict = judge(records)

    expect(verdict.state).toBe('matched')
    expect(verdict.evidence.matched).toMatchObject({ cacheDir: CACHE_DIR })
  })
})

// The local sweep drill (no --real-update) judges the same facts as the packaged drill, but it also
// runs against a dev app root, whose log directory is named "PureScience (DEV)". Reading a guessed
// name there silently produced "no purge line found" while the app had recorded the purge — a reading
// that looks like a product finding. These pin the two halves that keep it honest: the app names its
// own log file, and a non-event is counted rather than inferred.
describe('locating the app log through the app own answer', () => {
  it('reads from the directory of the log file the app named, dev name included', () => {
    const directories = logDirectoriesForLogFile({
      logPath: '/Users/runner/Library/Logs/PureScience (DEV)/main.log'
    })

    expect(directories).toEqual(['/Users/runner/Library/Logs/PureScience (DEV)'])
  })

  it('keeps the documented fallbacks when the app did not answer', () => {
    expect(logDirectoriesForLogFile({ logPath: null })).toBeUndefined()
    expect(logDirectoriesForLogFile({ logPath: '' })).toBeUndefined()
  })
})

describe('counting purges so that a non-event is measured', () => {
  const readRecords = async (lines: string[]): Promise<unknown[]> => {
    const directory = await writeLog(lines)
    return readAppUpdateCacheRecords({ home: '/nonexistent', directories: [directory] })
  }

  it('counts only the purges of the cache under test', async () => {
    const records = await readRecords([
      pendingRecord(CACHE_DIR, '2.31.2'),
      purgeRecord({ cacheDir: CACHE_DIR, installedVersion: '2.31.2', removedBytes: 42991788 }),
      purgeRecord({
        cacheDir: '/Users/runner/Library/Caches/other',
        installedVersion: '2.31.2',
        removedBytes: 42991788
      })
    ])

    expect(countPurgeRecords({ records, cacheDir: CACHE_DIR })).toBe(1)
    expect(countPurgeRecords({ records, cacheDir: '/tmp/another-cache' })).toBe(0)
  })
})

describe('judging the orphan record the app wrote for a partial download', () => {
  const PARTIAL = 'pending/temp-PureScience-2.31.3-arm64-mac.zip'

  const orphanRecord = (files: string[]): string =>
    JSON.stringify({
      t: '2026-11-20T19:53:13.165Z',
      level: 'info',
      scope: 'update',
      msg: 'update cache: removed orphaned partial downloads',
      data: { files }
    })

  const readRecords = async (lines: string[]): Promise<unknown[]> => {
    const directory = await writeLog(lines)
    return readAppUpdateCacheRecords({ home: '/nonexistent', directories: [directory] })
  }

  it('passes when the app recorded removing exactly the file that vanished', async () => {
    const records = await readRecords([orphanRecord([PARTIAL])])
    const verdict = judgeOrphanRemovalRecord({
      record: selectOrphanRecord({ records }),
      expectedFile: PARTIAL
    })

    expect(verdict.ok).toBe(true)
    expect(verdict.summary).toContain(PARTIAL)
    expect(verdict.evidence.matched).toMatchObject({ files: [PARTIAL] })
  })

  it('refuses to call a vanished file attributable when the app recorded no orphan removal', async () => {
    const records = await readRecords([pendingRecord(CACHE_DIR, '2.31.2')])
    const verdict = judgeOrphanRemovalRecord({
      record: selectOrphanRecord({ records }),
      expectedFile: PARTIAL
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('not attributable')
  })

  it('names the files the app actually removed when they are not the seeded partial', async () => {
    const records = await readRecords([
      orphanRecord(['pending/temp-PureScience-2.29.9-arm64-mac.zip'])
    ])
    const verdict = judgeOrphanRemovalRecord({
      record: selectOrphanRecord({ records }),
      expectedFile: PARTIAL
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.summary).toBe('the record names other files')
    expect(verdict.reason).toContain('2.29.9')
  })

  it('does not let a record left by an earlier run stand in for this one', async () => {
    // The seeded file name repeats across runs, so a stale record names the same file. What separates
    // them is position in the log, not content — which is why the drill passes a baseline count.
    const records = await readRecords([orphanRecord([PARTIAL])])

    expect(selectOrphanRecord({ records })?.data).toMatchObject({ files: [PARTIAL] })
    expect(selectOrphanRecord({ records, skip: 1 })).toBeUndefined()
  })
})
