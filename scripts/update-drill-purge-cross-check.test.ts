import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  judgePurgeRecord,
  readAppUpdateCacheRecords,
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
