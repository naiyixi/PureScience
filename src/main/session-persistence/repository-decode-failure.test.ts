import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Session encode/decode falls back to resolveDataRoot(), which reads electron's app.getPath.
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

// The failure this file is about: decoding a document's paths throws. `decodeSessionDataPaths` is the
// only step in the read that depends on the environment rather than on the bytes, and it used to share a
// `catch` with JSON parsing — so an environment failure renamed the user's document as if its content were
// corrupt. The body of the repository is real here; only this one function is replaced.
vi.mock('./session-data-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-data-paths')>()
  return {
    ...actual,
    decodeSessionDataPaths: (): never => {
      throw new TypeError("Cannot read properties of undefined (reading 'isPackaged')")
    }
  }
})

import { SESSION_FILE_VERSION } from '../../shared/session-persistence'
import { SessionRepository } from './repository'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'purescience-decode-failure-'))
  return storageRoot
}

// A document the product itself would write: wrapper version plus a Session whose content is valid.
const writableDocument = (id: string): string =>
  JSON.stringify({
    version: SESSION_FILE_VERSION,
    session: {
      id,
      projectId: 'project-a',
      title: 'Recovered conversation',
      cwd: '/workspace/project',
      status: 'idle',
      messages: [
        {
          id: `${id}-message-1`,
          role: 'user',
          content: 'Summarize this file',
          status: 'complete',
          eventIds: [],
          createdAt: 1710000000000,
          updatedAt: 1710000000000
        }
      ],
      createdAt: 1710000000000,
      updatedAt: 1710000000100
    }
  })

describe('session scan when path decoding fails', () => {
  it('reports an unreadable Session in place instead of quarantining a valid document', async () => {
    const root = await createStorageRoot()
    const projectDir = join(root, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    const documentPath = join(projectDir, 'session-1.json')
    const document = writableDocument('session-1')
    await writeFile(documentPath, document, 'utf8')
    const repository = new SessionRepository(root)

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.result.sessions).toEqual([])
    // Incomplete rather than corrupt: the scan could not answer, and it says so.
    expect(scan.isComplete).toBe(false)
    expect(scan.warnings).toEqual([
      {
        kind: 'unreadable',
        projectId: 'project-a',
        fileName: 'session-1.json',
        recovered: false
      }
    ])
    // The bytes are exactly where they were, and nothing was renamed beside them.
    await expect(readFile(documentPath, 'utf8')).resolves.toBe(document)
    expect(await readdir(projectDir)).toEqual(['session-1.json'])
  })

  it('still quarantines a document whose JSON does not parse', async () => {
    // The control: the harness above cannot isolate anything, so a green here means the corrupt branch
    // still moves its file for a reason that is about the content.
    const root = await createStorageRoot()
    const projectDir = join(root, 'sessions', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'broken.json'), '{broken json', 'utf8')
    const repository = new SessionRepository(root)

    const scan = await repository.loadAllWithDiagnostics()

    expect(scan.warnings).toEqual([
      {
        kind: 'corrupt',
        projectId: 'project-a',
        fileName: 'broken.json',
        recovered: true
      }
    ])
    expect(await readdir(projectDir)).toContainEqual(
      expect.stringMatching(/^broken\.json\.invalid-/)
    )
  })
})
