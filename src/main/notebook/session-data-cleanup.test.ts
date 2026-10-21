import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  deleteProjectNotebookData,
  deleteSessionNotebookData,
  measureSessionNotebookData
} from './session-data-cleanup'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'notebook-data-cleanup-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const seedProject = async (projectId: string, bytes: number): Promise<string> => {
  const dir = join(root, 'notebooks', projectId, 'run-1', 'data')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'results.h5ad'), Buffer.alloc(bytes, 9))
  return join(root, 'notebooks', projectId)
}

describe('deleting a project really releases its notebook data', () => {
  it('removes the directory and reports the bytes it freed', async () => {
    const projectDir = await seedProject('cmutflcqb000fwfm931kvwz21', 4096)
    const log = { info: vi.fn() }

    const result = await deleteProjectNotebookData(
      { dataRoot: root, log },
      'cmutflcqb000fwfm931kvwz21'
    )

    expect(result).toEqual({ freedBytes: 4096, state: 'removed' })
    await expect(access(projectDir)).rejects.toThrow()
    expect(log.info).toHaveBeenCalledWith('project notebook data removed', {
      projectId: 'cmutflcqb000fwfm931kvwz21',
      freedBytes: 4096
    })
  })

  it.skipIf(process.platform === 'win32')(
    'names the bytes it could not read instead of reporting a release of zero',
    async () => {
      // P0-10's second half: a directory that exists but cannot be listed has NO reading, so the receipt
      // must not carry a 0 that reads as "there was nothing there". Staged for real: `readdir` on the
      // sealed directory is denied for its owner, while `rm -r` only needs the parent's write+execute to
      // drop it once it is empty — so the removal genuinely succeeds and only the measurement has nothing.
      const projectId = 'cmutflcqb000fwfm931kvwz21'
      const projectDir = await seedProject(projectId, 1024)
      const sealed = join(projectDir, 'sealed')
      await mkdir(sealed, { recursive: true })
      await chmod(sealed, 0o000)
      const log = { info: vi.fn() }

      const result = await deleteProjectNotebookData({ dataRoot: root, log }, projectId)

      expect(result).toEqual({ freedBytes: 0, state: 'removed', freedBytesState: 'unreadable' })
      await expect(access(projectDir)).rejects.toThrow()
      expect(log.info).toHaveBeenCalledWith('project notebook data removed', {
        projectId,
        freedBytes: 0,
        freedBytesState: 'unreadable'
      })
    }
  )

  it('names "absent" instead of claiming zero bytes freed, and says so in the log', async () => {
    const log = { info: vi.fn() }
    const result = await deleteProjectNotebookData(
      { dataRoot: root, log },
      'cmnosuchproject00000000000'
    )

    expect(result).toEqual({ freedBytes: 0, state: 'absent' })
    // The log line is what keeps "nothing was there" distinguishable from "the removal did not happen".
    expect(log.info).toHaveBeenCalledWith('project notebook data absent', {
      projectId: 'cmnosuchproject00000000000'
    })
  })

  it('refuses an id that could escape the notebooks directory, and touches nothing', async () => {
    const victim = join(root, 'outside')
    await mkdir(victim, { recursive: true })
    await writeFile(join(victim, 'keep.txt'), 'precious')
    const projectDir = await seedProject('safe-project', 128)
    const log = { info: vi.fn() }

    const escaped = await deleteProjectNotebookData({ dataRoot: root, log }, '../../outside')

    expect(escaped).toEqual({ freedBytes: 0, state: 'refused' })
    expect(log.info).toHaveBeenCalledWith('project notebook data refused', {
      reason: 'unsafe-project-id'
    })
    // Both the target outside the notebooks tree and an unrelated project are untouched.
    await expect(access(join(victim, 'keep.txt'))).resolves.toBeUndefined()
    await expect(access(projectDir)).resolves.toBeUndefined()
  })
})

const seedSession = async (
  projectId: string,
  sessionId: string,
  bytes: number
): Promise<string> => {
  const dir = join(root, 'notebooks', projectId, sessionId, 'run-1', 'data')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'results.h5ad'), Buffer.alloc(bytes, 7))
  return join(root, 'notebooks', projectId, sessionId)
}

describe('deleting one session really releases the run data that session owned', () => {
  it('removes only that session and reports the bytes it freed', async () => {
    const projectId = 'cmutflcqb000fwfm931kvwz21'
    const sessionId = '9f1c2f4a-1111-4a2b-8c3d-000000000001'
    const siblingId = '9f1c2f4a-1111-4a2b-8c3d-000000000002'
    const sessionDir = await seedSession(projectId, sessionId, 2048)
    const siblingDir = await seedSession(projectId, siblingId, 512)
    const log = { info: vi.fn() }

    const result = await deleteSessionNotebookData({ dataRoot: root, log }, projectId, sessionId)

    expect(result).toEqual({ freedBytes: 2048, state: 'removed' })
    await expect(access(sessionDir)).rejects.toThrow()
    // The session that was not deleted, and the project that contains both, are untouched.
    await expect(access(join(siblingDir, 'run-1', 'data', 'results.h5ad'))).resolves.toBeUndefined()
    await expect(access(join(root, 'notebooks', projectId))).resolves.toBeUndefined()
    expect(log.info).toHaveBeenCalledWith('session notebook data removed', {
      projectId,
      sessionId,
      freedBytes: 2048
    })
  })

  it.skipIf(process.platform === 'win32')(
    'names an unreadable figure for the session instead of releasing zero bytes on paper',
    async () => {
      // Same distinction one level down: the session's run data really is removed, and no figure exists for
      // it. The receipt the renderer prints must be able to tell that apart from an empty directory.
      const projectId = 'cmutflcqb000fwfm931kvwz21'
      const sessionId = '9f1c2f4a-1111-4a2b-8c3d-00000000000a'
      const sessionDir = await seedSession(projectId, sessionId, 2048)
      await mkdir(join(sessionDir, 'sealed'), { recursive: true })
      await chmod(join(sessionDir, 'sealed'), 0o000)
      const log = { info: vi.fn() }

      const result = await deleteSessionNotebookData({ dataRoot: root, log }, projectId, sessionId)

      expect(result).toEqual({ freedBytes: 0, state: 'removed', freedBytesState: 'unreadable' })
      await expect(access(sessionDir)).rejects.toThrow()
      expect(log.info).toHaveBeenCalledWith('session notebook data removed', {
        projectId,
        sessionId,
        freedBytes: 0,
        freedBytesState: 'unreadable'
      })
    }
  )

  it('names "absent" for a session that stored nothing, instead of claiming a release', async () => {
    const log = { info: vi.fn() }

    const result = await deleteSessionNotebookData(
      { dataRoot: root, log },
      'cmnosuchproject00000000000',
      '9f1c2f4a-1111-4a2b-8c3d-000000000003'
    )

    expect(result).toEqual({ freedBytes: 0, state: 'absent' })
    expect(log.info).toHaveBeenCalledWith('session notebook data absent', {
      projectId: 'cmnosuchproject00000000000',
      sessionId: '9f1c2f4a-1111-4a2b-8c3d-000000000003'
    })
  })

  it('refuses an id that could escape the notebooks directory, and touches nothing', async () => {
    const projectId = 'cmutflcqb000fwfm931kvwz21'
    const insideDir = await seedSession(projectId, '9f1c2f4a-1111-4a2b-8c3d-000000000004', 128)
    const log = { info: vi.fn() }

    const escapedProject = await deleteSessionNotebookData(
      { dataRoot: root, log },
      '../../outside',
      '9f1c2f4a-1111-4a2b-8c3d-000000000004'
    )
    const escapedSession = await deleteSessionNotebookData(
      { dataRoot: root, log },
      projectId,
      '../9f1c2f4a-1111-4a2b-8c3d-000000000004'
    )

    expect(escapedProject).toEqual({ freedBytes: 0, state: 'refused' })
    expect(escapedSession).toEqual({ freedBytes: 0, state: 'refused' })
    expect(log.info).toHaveBeenCalledWith('session notebook data refused', {
      reason: 'unsafe-project-id'
    })
    expect(log.info).toHaveBeenCalledWith('session notebook data refused', {
      reason: 'unsafe-session-id'
    })
    // The session the second refusal addressed by traversal is still there, byte for byte.
    await expect(access(join(insideDir, 'run-1', 'data', 'results.h5ad'))).resolves.toBeUndefined()
  })
})

// The confirmation that precedes a session delete prints what else that action takes with it, so it needs
// a reading taken BEFORE anything is removed — and that reading must not be able to remove anything itself.
describe('reading what one session holds before it is deleted', () => {
  it('answers with the bytes that session produced, and deletes nothing', async () => {
    const projectId = 'cmutflcqb000fwfm931kvwz21'
    const sessionId = '9f1c2f4a-1111-4a2b-8c3d-000000000005'
    const sessionDir = await seedSession(projectId, sessionId, 4096)

    const usage = await measureSessionNotebookData({ dataRoot: root }, projectId, sessionId)

    expect(usage).toEqual({ state: 'measured', bytes: 4096 })
    // The property that makes this safe to call while the user is still deciding.
    await expect(access(join(sessionDir, 'run-1', 'data', 'results.h5ad'))).resolves.toBeUndefined()
  })

  it('names a session with no run data as absent rather than as zero bytes', async () => {
    const usage = await measureSessionNotebookData(
      { dataRoot: root },
      'cmutflcqb000fwfm931kvwz21',
      '9f1c2f4a-1111-4a2b-8c3d-000000000006'
    )

    expect(usage).toEqual({ state: 'absent' })
  })

  it('refuses an id that could escape the notebooks directory instead of measuring beside it', async () => {
    const log = { info: vi.fn() }

    const projectEscape = await measureSessionNotebookData(
      { dataRoot: root, log },
      '../../outside',
      '9f1c2f4a-1111-4a2b-8c3d-000000000007'
    )
    const sessionEscape = await measureSessionNotebookData(
      { dataRoot: root, log },
      'cmutflcqb000fwfm931kvwz21',
      '../9f1c2f4a-1111-4a2b-8c3d-000000000007'
    )

    expect(projectEscape).toEqual({ state: 'unavailable', reason: 'unsafe-id' })
    expect(sessionEscape).toEqual({ state: 'unavailable', reason: 'unsafe-id' })
    expect(log.info).toHaveBeenCalledWith('session notebook data not measured', {
      reason: 'unsafe-project-id'
    })
    expect(log.info).toHaveBeenCalledWith('session notebook data not measured', {
      reason: 'unsafe-session-id'
    })
  })
})
