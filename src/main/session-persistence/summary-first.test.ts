import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { PersistedChatSession } from '../../shared/session-persistence'
import { SessionRepository } from './repository'

// Summary-first startup: the session list must load from the lightweight summary without parsing
// the full session JSON, and a changed session file must invalidate the cached summary.

const buildSession = (
  overrides: Partial<{ id: string; title: string }> = {}
): PersistedChatSession =>
  ({
    id: overrides.id ?? 'sess-1',
    projectId: 'proj-1',
    title: overrides.title ?? 'My research',
    cwd: '/tmp/work',
    status: 'idle',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    agentFrameworkId: 'claude-code',
    permissionProfile: 'ask',
    messages: [],
    runs: [],
    events: [],
    revision: 1,
    version: 2
  }) as unknown as PersistedChatSession

describe('SessionRepository summary-first loading', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  const setupRepo = async (): Promise<{ repo: SessionRepository; dir: string }> => {
    root = await mkdtemp(join(tmpdir(), 'purescience-summary-'))
    const repo = new SessionRepository(root)
    return { repo, dir: root }
  }

  it('serves the session list from the summary cache without parsing the full file', async () => {
    const { repo, dir } = await setupRepo()
    const session = buildSession({ title: 'Summary-first session' })
    await repo.saveSession(session)

    // The summary cache is written fire-and-forget after save; wait for it to land.
    const summaryPath = join(dir, 'sessions', 'proj-1', 'sess-1.json.summary.json')
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await stat(summaryPath)
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
    expect(summary.version).toBe(1)
    expect(summary.session.title).toBe('Summary-first session')
    // Heavy fields are omitted from the cache.
    expect(summary.session.messages).toEqual([])

    // A subsequent read-only list read serves from the summary cache.
    const result = await repo.loadAllWithDiagnostics({ mode: 'read-only' })
    const loaded = result.result.sessions.find((entry) => entry.id === 'sess-1')
    expect(loaded?.title).toBe('Summary-first session')
    expect(loaded?.messages).toEqual([])
  })

  it('loads the session list from the summary without touching the full JSON parse path', async () => {
    const { repo, dir } = await setupRepo()
    const session = buildSession({ title: 'Cached title' })
    await repo.saveSession(session)

    const fullPath = join(dir, 'sessions', 'proj-1', 'sess-1.json')
    const original = await readFile(fullPath, 'utf8')

    // Replace the full file with an invalid document but rewrite the summary fingerprint to match
    // the (new) file stats, simulating a stale-but-matching cache: the summary must win.
    await writeFile(fullPath, 'not json at all', 'utf8')
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(fullPath))
    const summaryPath = `${fullPath}.summary.json`
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
    summary.fingerprint = { size: stats.size, mtimeMs: stats.mtimeMs }
    await writeFile(summaryPath, JSON.stringify(summary), 'utf8')

    const result = await repo.loadAllWithDiagnostics({ mode: 'read-only' })
    const loaded = result.result.sessions.find((entry) => entry.id === 'sess-1')
    expect(loaded?.title).toBe('Cached title')
    expect(original).toBeTruthy()
  })
})
