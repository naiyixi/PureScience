import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveAllowedImportFilePath } from './storage-access'

// Where a relative source name resolves, and what else carries that name.
//
// The rule itself is deliberate: during a Notebook turn a bare name resolves against the kernel directory, and
// the session root is probed only for a Notebook `data/...` path, because probing the wider workspace could
// silently import a stale same-named file from outside the session. What these cases pin is that the resolver
// says which directory answered and which other probed roots hold the same name, instead of leaving a writer
// with no way to tell why its own freshly written file was not the one that got imported.

describe('resolveAllowedImportFilePath', () => {
  let root: string
  let kernelDir: string
  let workspaceDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ps-import-'))
    kernelDir = join(root, 'kernel-cwd')
    workspaceDir = join(root, 'workspace')
    await mkdir(kernelDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('names the base that answered and the other roots holding the same name', async () => {
    await writeFile(join(kernelDir, 'plot.png'), 'kernel')
    await writeFile(join(workspaceDir, 'plot.png'), 'workspace')

    const report = await resolveAllowedImportFilePath(
      'plot.png',
      [kernelDir, workspaceDir],
      [kernelDir, workspaceDir]
    )

    expect(report.path).toBe(await realpath(join(kernelDir, 'plot.png')))
    expect(report.resolvedFrom).toBe(kernelDir)
    expect(report.alsoPresentIn).toEqual([workspaceDir])
  })

  it('falls through to a later base when the earlier one does not have the file', async () => {
    await writeFile(join(workspaceDir, 'only-here.png'), 'workspace')

    const report = await resolveAllowedImportFilePath(
      'only-here.png',
      [kernelDir, workspaceDir],
      [kernelDir, workspaceDir]
    )

    expect(report.path).toBe(await realpath(join(workspaceDir, 'only-here.png')))
    expect(report.resolvedFrom).toBe(workspaceDir)
    expect(report.alsoPresentIn).toEqual([])
  })

  it('names every probed directory when nothing has the file', async () => {
    await expect(
      resolveAllowedImportFilePath('never-saved.png', [kernelDir], [kernelDir, workspaceDir])
    ).rejects.toThrow(/Looked in: .*kernel-cwd.*workspace/)
  })

  it('reports no base for an absolute path', async () => {
    await writeFile(join(workspaceDir, 'absolute.png'), 'workspace')
    const absolute = join(workspaceDir, 'absolute.png')

    const report = await resolveAllowedImportFilePath(absolute, [workspaceDir], [kernelDir])

    expect(report.path).toBe(await realpath(absolute))
    expect(report.resolvedFrom).toBeUndefined()
    expect(report.alsoPresentIn).toEqual([])
  })
})
