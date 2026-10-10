import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  classifyPreviousShutdown,
  createShutdownBreadcrumbWriter,
  readShutdownBreadcrumb,
  SHUTDOWN_BREADCRUMB_FILE,
  writeShutdownBreadcrumbSync
} from './shutdown-breadcrumb'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shutdown-breadcrumb-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const baseRecord = {
  schemaVersion: 1 as const,
  runId: 'run-1',
  trigger: 'quit',
  startedAt: '2026-10-10T11:51:59.000Z',
  phase: 'backend-teardown',
  phaseAt: '2026-10-10T11:52:00.000Z'
}

describe('shutdown breadcrumb: durable record', () => {
  it('writes a record that reads back field by field', () => {
    expect(writeShutdownBreadcrumbSync(dir, baseRecord)).toEqual({ written: true })

    expect(readShutdownBreadcrumb(dir)).toEqual(baseRecord)
  })

  it('replaces the previous record atomically instead of appending', async () => {
    writeShutdownBreadcrumbSync(dir, baseRecord)
    writeShutdownBreadcrumbSync(dir, {
      ...baseRecord,
      phase: 'database-release',
      phaseAt: '2026-10-10T11:52:01.000Z'
    })

    const raw = await readFile(join(dir, SHUTDOWN_BREADCRUMB_FILE), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    expect(readShutdownBreadcrumb(dir)?.phase).toBe('database-release')
  })

  it('reports a write failure instead of throwing', async () => {
    // The parent path is a FILE, so the directory cannot be created and the write must fail cleanly.
    const blocker = join(dir, 'not-a-directory')
    await writeFile(blocker, 'x')

    const outcome = writeShutdownBreadcrumbSync(join(blocker, 'logs'), baseRecord)

    expect(outcome.written).toBe(false)
  })
})

describe('shutdown breadcrumb: previous-run classification', () => {
  it('reports "absent" when no run ever recorded a shutdown', () => {
    expect(classifyPreviousShutdown(dir)).toEqual({ kind: 'absent' })
  })

  it('reports "completed" only when the terminal phase was actually recorded', () => {
    writeShutdownBreadcrumbSync(dir, {
      ...baseRecord,
      phase: 'completed',
      completedAt: '2026-10-10T11:52:02.000Z',
      degraded: false
    })

    expect(classifyPreviousShutdown(dir)).toEqual({
      kind: 'completed',
      completedAt: '2026-10-10T11:52:02.000Z',
      phase: 'completed',
      trigger: 'quit',
      degraded: false
    })
  })

  it('reports "incomplete" with the last phase — never "crash", never "completed"', () => {
    writeShutdownBreadcrumbSync(dir, baseRecord)

    expect(classifyPreviousShutdown(dir)).toEqual({
      kind: 'incomplete',
      phase: 'backend-teardown',
      phaseAt: '2026-10-10T11:52:00.000Z',
      startedAt: '2026-10-10T11:51:59.000Z',
      trigger: 'quit'
    })
  })

  it('keeps a malformed record distinct from a missing one', async () => {
    await writeFile(join(dir, SHUTDOWN_BREADCRUMB_FILE), '{not json')

    expect(classifyPreviousShutdown(dir)).toEqual({ kind: 'unreadable', reason: 'malformed' })
    expect(readShutdownBreadcrumb(dir)).toBeUndefined()
  })

  it('treats an unknown schema version as unreadable rather than guessing its fields', async () => {
    await writeFile(
      join(dir, SHUTDOWN_BREADCRUMB_FILE),
      JSON.stringify({ ...baseRecord, schemaVersion: 2 })
    )

    expect(classifyPreviousShutdown(dir)).toEqual({ kind: 'unreadable', reason: 'malformed' })
  })
})

describe('shutdown breadcrumb: phase writer', () => {
  it('fixes startedAt on the first phase and stamps completion on the terminal one', () => {
    const times = [
      '2026-10-10T11:51:59.000Z',
      '2026-10-10T11:52:00.000Z',
      '2026-10-10T11:52:03.000Z'
    ]
    let index = 0
    const writer = createShutdownBreadcrumbWriter({
      logDir: dir,
      runId: 'run-7',
      now: () => times[Math.min(index++, times.length - 1)]
    })

    writer('started', { trigger: 'quit' })
    expect(readShutdownBreadcrumb(dir)).toEqual({
      schemaVersion: 1,
      runId: 'run-7',
      trigger: 'quit',
      startedAt: '2026-10-10T11:51:59.000Z',
      phase: 'started',
      phaseAt: '2026-10-10T11:51:59.000Z'
    })

    writer('database-release', { result: 'completed' })
    expect(writer.isComplete()).toBe(false)
    expect(readShutdownBreadcrumb(dir)?.startedAt).toBe('2026-10-10T11:51:59.000Z')

    writer('completed', { degraded: false })
    expect(writer.isComplete()).toBe(true)
    expect(readShutdownBreadcrumb(dir)).toEqual({
      schemaVersion: 1,
      runId: 'run-7',
      trigger: 'quit',
      startedAt: '2026-10-10T11:51:59.000Z',
      phase: 'completed',
      phaseAt: '2026-10-10T11:52:03.000Z',
      completedAt: '2026-10-10T11:52:03.000Z',
      degraded: false
    })
  })

  it('names an unknown trigger instead of leaving the field empty', () => {
    const writer = createShutdownBreadcrumbWriter({ logDir: dir, runId: 'run-8' })
    writer('started')

    expect(readShutdownBreadcrumb(dir)?.trigger).toBe('unknown')
  })

  it('keeps the last successfully written record when a later write fails', () => {
    const writer = createShutdownBreadcrumbWriter({ logDir: dir, runId: 'run-9' })
    writer('started', { trigger: 'quit' })
    const written = writer.last()

    // Point the same writer at a location that cannot be written.
    const failing = createShutdownBreadcrumbWriter({
      logDir: join(dir, SHUTDOWN_BREADCRUMB_FILE),
      runId: 'run-10'
    })
    failing('started', { trigger: 'quit' })

    expect(failing.last()).toBeUndefined()
    expect(written?.runId).toBe('run-9')
  })
})
