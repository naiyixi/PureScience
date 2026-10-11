import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteProjectNotebookData } from './session-data-cleanup'

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
