// The reading journal: what it keeps, what it refuses, and what it says when there is nothing.

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CONNECTOR_READINGS_DIR,
  MAX_SESSION_READINGS,
  readSessionReadings,
  recordSessionReadings
} from './reading-journal'
import type { ConnectorReadingFingerprint } from '../../shared/reading-fingerprint'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'purescience-reading-journal-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const reading = (tool: string): ConnectorReadingFingerprint => ({
  service: 'pubmed',
  tool,
  request: { method: 'GET', url: `https://example.test/${tool}` },
  response: { status: 200, bytes: 12, sha256: `sha256:${'a'.repeat(64)}` }
})

describe('the connector reading journal', () => {
  it('keeps readings per session and reads them back in order', async () => {
    await recordSessionReadings(
      root,
      'session-1',
      [reading('first')],
      () => new Date('2026-10-08T01:00:00.000Z')
    )
    await recordSessionReadings(
      root,
      'session-1',
      [reading('second')],
      () => new Date('2026-10-08T02:00:00.000Z')
    )

    const result = await readSessionReadings(root, 'session-1')
    expect(result.state).toBe('available')
    if (result.state !== 'available') return
    expect(result.entries.map((entry) => entry.reading.tool)).toEqual(['first', 'second'])
    expect(result.entries.map((entry) => entry.recordedAt)).toEqual([
      '2026-10-08T01:00:00.000Z',
      '2026-10-08T02:00:00.000Z'
    ])
    expect(result.dropped).toBe(0)
  })

  it('says `not-recorded` for a session that never read anything — never an empty success', async () => {
    expect(await readSessionReadings(root, 'never-used')).toEqual({
      state: 'unavailable',
      reason: 'not-recorded'
    })
  })

  it('never leaves a partial journal behind (it writes beside the target and renames)', async () => {
    await recordSessionReadings(root, 'session-1', [reading('first')])
    const files = await readdir(join(root, CONNECTOR_READINGS_DIR))
    expect(files).toEqual(['session-1.json'])
  })

  it('keeps the newest entries at the cap and reports how many it dropped', async () => {
    const many = Array.from({ length: MAX_SESSION_READINGS + 5 }, (_, index) =>
      reading(`t${index}`)
    )
    await recordSessionReadings(root, 'session-1', many)

    const result = await readSessionReadings(root, 'session-1')
    expect(result.state).toBe('available')
    if (result.state !== 'available') return
    expect(result.entries).toHaveLength(MAX_SESSION_READINGS)
    // Newest kept: the last reading is still there, the first five are not.
    expect(result.entries[result.entries.length - 1].reading.tool).toBe(
      `t${MAX_SESSION_READINGS + 4}`
    )
    expect(result.dropped).toBe(5)
  })

  it('refuses a session id that could escape its directory, and records nothing', async () => {
    for (const unsafe of ['../../etc/passwd', 'a/b', 'a\\b', '', '   ']) {
      expect(await recordSessionReadings(root, unsafe, [reading('x')])).toBe(false)
      expect(await readSessionReadings(root, unsafe)).toEqual({
        state: 'unavailable',
        reason: 'not-recorded'
      })
    }
  })

  it('reports a corrupt journal as unreadable rather than as nothing read', async () => {
    await recordSessionReadings(root, 'session-1', [reading('first')])
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, CONNECTOR_READINGS_DIR, 'session-1.json'), '{ not json', 'utf8')
    expect(await readSessionReadings(root, 'session-1')).toEqual({
      state: 'unavailable',
      reason: 'unreadable'
    })
  })

  it('refuses a journal whose digest is not a well-formed fingerprint, rather than serving it', async () => {
    await recordSessionReadings(root, 'session-1', [reading('first')])
    const { readFile, writeFile } = await import('node:fs/promises')
    const path = join(root, CONNECTOR_READINGS_DIR, 'session-1.json')
    const journal = JSON.parse(await readFile(path, 'utf8')) as {
      entries: { reading: { response: { sha256: string } } }[]
    }
    // A digest nobody could recompute: presenting it as a reading would advertise a check that cannot
    // be performed, so the whole journal is reported unreadable instead.
    journal.entries[0].reading.response.sha256 = 'not-a-fingerprint'
    await writeFile(path, JSON.stringify(journal), 'utf8')
    expect(await readSessionReadings(root, 'session-1')).toEqual({
      state: 'unavailable',
      reason: 'unreadable'
    })
  })

  it('records nothing for an empty reading list, so no empty journal appears', async () => {
    expect(await recordSessionReadings(root, 'session-1', [])).toBe(false)
    expect(await readSessionReadings(root, 'session-1')).toEqual({
      state: 'unavailable',
      reason: 'not-recorded'
    })
  })
})
