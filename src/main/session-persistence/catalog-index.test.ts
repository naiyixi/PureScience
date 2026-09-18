import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { PersistedChatSession } from '../../shared/session-persistence'
import { SessionRepository } from './repository'

// The list tier's own scan: the on-disk index answers for every session it still describes, and a
// document is parsed only for the entries it does not. These cases are the acceptance's five claims —
// cold start reads the index without parsing, a size/mtime change invalidates exactly that entry, an
// external create or delete is still seen, and a missing index falls back to a full rebuild — plus the
// one that decides whether the list is right at all: the count and the last agent message survive,
// because they cannot be recomputed from an index that carries no messages.

const buildSession = (
  overrides: { id?: string; title?: string; messageCount?: number } = {}
): PersistedChatSession => {
  const id = overrides.id ?? 'sess-1'
  const messageCount = overrides.messageCount ?? 0
  // The last message is an agent turn: the list's preview is the last agent message, so a fixture that
  // ends on a user turn would not exercise it.
  const messages = Array.from({ length: messageCount }, (_value, index) => ({
    id: `${id}-m${index}`,
    role: index === messageCount - 1 ? 'agent' : index % 2 === 0 ? 'user' : 'agent',
    content: index === messageCount - 1 ? `answer from ${id}` : `turn ${index}`
  }))
  return {
    id,
    projectId: 'proj-1',
    title: overrides.title ?? 'My research',
    cwd: '/tmp/work',
    status: 'idle',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    agentFrameworkId: 'claude-code',
    permissionProfile: 'ask',
    messages,
    runs: [],
    events: [],
    revision: 1,
    version: 2
  } as unknown as PersistedChatSession
}

// Counts document reads only. The index read goes through the same dependency, so counting every call
// would count the thing under test's own bookkeeping.
const createCountingReads = (): {
  reads: string[]
  readSessionFile: (path: string) => Promise<string>
} => {
  const reads: string[] = []
  return {
    reads,
    readSessionFile: async (path: string) => {
      if (!path.endsWith('.summary.json')) reads.push(path)
      return readFile(path, 'utf8')
    }
  }
}

const documentPaths = (root: string, projectId = 'proj-1'): string =>
  join(root, 'sessions', projectId)

describe('SessionRepository catalog index', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  const setup = async (): Promise<{ dir: string; writes: SessionRepository }> => {
    root = await mkdtemp(join(tmpdir(), 'purescience-catalog-'))
    return { dir: root, writes: new SessionRepository(root) }
  }

  // A fresh repository instance over the same directory: what a cold start sees.
  const coldStart = (dir: string): { repository: SessionRepository; reads: string[] } => {
    const counting = createCountingReads()
    return {
      repository: new SessionRepository(dir, { readSessionFile: counting.readSessionFile }),
      reads: counting.reads
    }
  }

  it('answers a cold start from the index without parsing a single document', async () => {
    const { dir, writes } = await setup()
    await writes.saveSession(buildSession({ id: 'sess-1', messageCount: 3 }))
    await writes.saveSession(buildSession({ id: 'sess-2', title: 'Second', messageCount: 1 }))
    // Saving warms the index in the background; wait for both entries to be on disk.
    await waitForIndexEntries(documentPaths(dir), 2)

    const { repository, reads } = coldStart(dir)
    const scan = await repository.loadCatalogWithDiagnostics()

    expect(scan.index).toEqual({ hits: 2, parsedDocuments: 0 })
    expect(reads).toEqual([])
    expect(scan.isComplete).toBe(true)
    const first = scan.result.sessions.find((entry) => entry.id === 'sess-1')
    // The whole point of storing the projection: a slice-only index would report 0 and undefined here.
    expect(first?.messageCount).toBe(3)
    expect(first?.lastAgentMessage).toBe('answer from sess-1')
    expect(first?.title).toBe('My research')
    // And the payload still excludes the active Branch's content.
    expect(first !== undefined && 'messages' in first).toBe(false)
    expect(first !== undefined && 'conversationGraph' in first).toBe(false)
    expect(scan.result.manifest).toEqual({ version: 1 })
  })

  it('re-parses exactly the entry whose document changed, and no others', async () => {
    const { dir, writes } = await setup()
    await writes.saveSession(buildSession({ id: 'sess-1' }))
    await writes.saveSession(buildSession({ id: 'sess-2' }))
    await waitForIndexEntries(documentPaths(dir), 2)

    // An external editor: the document is rewritten behind the repository's back, so the index entry
    // is stale but present. Same byte count as before (only the title differs in length on purpose).
    const target = join(documentPaths(dir), 'sess-1.json')
    const original = JSON.parse(await readFile(target, 'utf8')) as { session: { title: string } }
    original.session.title = 'Edited outside the app'
    await writeFile(target, JSON.stringify(original, null, 2), 'utf8')

    const { repository, reads } = coldStart(dir)
    const scan = await repository.loadCatalogWithDiagnostics()

    expect(scan.index).toEqual({ hits: 1, parsedDocuments: 1 })
    expect(reads).toEqual([target])
    expect(scan.result.sessions.find((entry) => entry.id === 'sess-1')?.title).toBe(
      'Edited outside the app'
    )
    expect(scan.result.sessions.find((entry) => entry.id === 'sess-2')?.title).toBe('My research')

    // The parse rewrote that one entry, so the next cold start is back to zero reads.
    const next = coldStart(dir)
    await next.repository.loadCatalogWithDiagnostics()
    expect(next.reads).toEqual([])
  })

  it('sees a session created outside the app, and stops parsing it once indexed', async () => {
    const { dir, writes } = await setup()
    await writes.saveSession(buildSession({ id: 'sess-1' }))
    await waitForIndexEntries(documentPaths(dir), 1)

    // Copied in with no index entry at all: the directory walk is what must find it.
    const source = await readFile(join(documentPaths(dir), 'sess-1.json'), 'utf8')
    const added = source.replace(/"sess-1"/gu, '"sess-external"')
    expect(added).not.toBe(source)
    await writeFile(join(documentPaths(dir), 'sess-external.json'), added, 'utf8')

    const { repository, reads } = coldStart(dir)
    const scan = await repository.loadCatalogWithDiagnostics()

    expect(scan.result.sessions.map((entry) => entry.id).sort()).toEqual([
      'sess-1',
      'sess-external'
    ])
    expect(scan.index).toEqual({ hits: 1, parsedDocuments: 1 })
    expect(reads).toEqual([join(documentPaths(dir), 'sess-external.json')])

    const next = coldStart(dir)
    await next.repository.loadCatalogWithDiagnostics()
    expect(next.reads).toEqual([])
  })

  it('drops a session deleted outside the app, without reading anything', async () => {
    const { dir, writes } = await setup()
    await writes.saveSession(buildSession({ id: 'sess-1' }))
    await writes.saveSession(buildSession({ id: 'sess-2' }))
    await waitForIndexEntries(documentPaths(dir), 2)

    await rm(join(documentPaths(dir), 'sess-1.json'))

    const { repository, reads } = coldStart(dir)
    const scan = await repository.loadCatalogWithDiagnostics()

    expect(scan.result.sessions.map((entry) => entry.id)).toEqual(['sess-2'])
    expect(reads).toEqual([])
  })

  it('rebuilds the whole index when it is missing, then serves from it again', async () => {
    const { dir, writes } = await setup()
    await writes.saveSession(buildSession({ id: 'sess-1' }))
    await writes.saveSession(buildSession({ id: 'sess-2' }))
    await waitForIndexEntries(documentPaths(dir), 2)
    for (const name of await readdir(documentPaths(dir))) {
      if (name.endsWith('.summary.json')) await rm(join(documentPaths(dir), name))
    }

    const rebuild = coldStart(dir)
    const rebuilt = await rebuild.repository.loadCatalogWithDiagnostics()

    expect(rebuilt.index).toEqual({ hits: 0, parsedDocuments: 2 })
    expect(rebuild.reads).toHaveLength(2)
    expect(rebuilt.result.sessions).toHaveLength(2)

    // The rebuild persisted the entries, so the next scan is index-only.
    const next = coldStart(dir)
    const served = await next.repository.loadCatalogWithDiagnostics()
    expect(served.index).toEqual({ hits: 2, parsedDocuments: 0 })
    expect(next.reads).toEqual([])
  })

  it('fails closed on an unreadable document and leaves the file in place', async () => {
    const { dir, writes } = await setup()
    await writes.saveSession(buildSession({ id: 'sess-1' }))
    await waitForIndexEntries(documentPaths(dir), 1)

    const target = join(documentPaths(dir), 'sess-1.json')
    await writeFile(target, 'not json at all', 'utf8')

    const { repository } = coldStart(dir)
    const scan = await repository.loadCatalogWithDiagnostics()

    expect(scan.isComplete).toBe(false)
    expect(scan.warnings.map((warning) => warning.kind)).toContain('corrupt')
    expect(scan.result.sessions).toEqual([])
    // A list read must not move a user's file: quarantine belongs to the reconciliation pass.
    await expect(lstat(target)).resolves.toBeDefined()
  })
})

const waitForIndexEntries = async (projectDir: string, expected: number): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const names = await readdir(projectDir).catch(() => [] as string[])
    if (names.filter((name) => name.endsWith('.summary.json')).length >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Index entries did not land: expected ${expected}`)
}
