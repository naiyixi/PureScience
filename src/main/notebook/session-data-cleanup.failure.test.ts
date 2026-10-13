import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The removal throws here. A real EBUSY/EACCES cannot be staged portably — a runner that happens to be
// root walks straight through a permission bit — so the failure is injected at the module boundary and
// the test asserts the *reporting* the failure path owes the user.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: vi.fn(async () => {
      throw new Error('EBUSY: resource busy or locked')
    })
  }
})

import { access } from 'node:fs/promises'

import { deleteSessionNotebookData } from './session-data-cleanup'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'notebook-session-cleanup-failure-'))
})

afterAll(async () => {
  // Clean up through the real implementation: this file's `rm` is the injected failure.
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  await actual.rm(root, { recursive: true, force: true })
})

describe('a session run data removal that throws', () => {
  it('names the failure and reports zero bytes instead of bytes that are still on disk', async () => {
    const projectId = 'cmutflcqb000fwfm931kvwz21'
    const sessionId = '9f1c2f4a-1111-4a2b-8c3d-00000000000f'
    const sessionDir = join(root, 'notebooks', projectId, sessionId, 'run-1', 'data')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'results.h5ad'), Buffer.alloc(4096, 3))
    const log = { info: vi.fn() }

    const result = await deleteSessionNotebookData({ dataRoot: root, log }, projectId, sessionId)

    // 'failed', not 'refused' (the id addressed a real directory) and not 'absent' (there were bytes):
    // the session record is already gone, so this outcome is the one the user has to be told about.
    expect(result).toEqual({ freedBytes: 0, state: 'failed' })
    expect(log.info).toHaveBeenCalledWith('session notebook data removal failed', {
      projectId,
      sessionId,
      reason: 'EBUSY: resource busy or locked'
    })
    // The bytes really are still there — which is exactly why the receipt must not claim them.
    await expect(access(join(sessionDir, 'results.h5ad'))).resolves.toBeUndefined()
  })
})
