import { readFile, mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { WebContents } from 'electron'

import { RoCrateExportError } from './export'
import { createRoCrateExportOwner, type RoCrateExportOwnerDeps } from './ipc'
import { writeDurableVersion } from './export-test-fixtures'

let scratch: string | undefined

const createScratch = async (): Promise<string> => {
  scratch = await mkdtemp(join(tmpdir(), 'purescience-ro-crate-ipc-'))
  return scratch
}

afterEach(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
    scratch = undefined
  }
})

const APP = { name: 'PureScience', version: '1.75.0', url: 'https://www.zerolink.com/purescience' }
const SENDER = {} as WebContents

const ownerFor = (
  storageRoot: string,
  overrides: Partial<RoCrateExportOwnerDeps> = {}
): ReturnType<typeof createRoCrateExportOwner> =>
  createRoCrateExportOwner({
    storageRoot,
    loadProject: async (projectId) => ({ id: projectId, name: 'Assay project', description: '' }),
    app: APP,
    getDefaultDir: () => storageRoot,
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    now: () => new Date('2026-09-30T00:00:00.000Z'),
    log: { warn: () => undefined },
    ...overrides
  })

describe('RO-Crate export IPC owner', () => {
  it('writes a crate for the project and reports what a reader can check', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      filename: 'assay.csv',
      body: 'a,b\n1,2\n',
      contentType: 'text/csv'
    })
    const outputDir = join(storageRoot, 'crate')

    const result = await ownerFor(storageRoot).exportProject(
      { projectId: 'project-1', destinationPath: outputDir },
      SENDER
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outputDir).toBe(outputDir)
    expect(result.metadataPath).toBe(join(outputDir, 'ro-crate-metadata.json'))
    expect(result.fileCount).toBe(1)
    expect(result.totalBytes).toBe('a,b\n1,2\n'.length)
    expect(result.validation).toEqual({ passed: 30, failed: 0 })
    expect(result.refusedCount).toBe(0)
    // The crate is really on disk, and the payload is the stored bytes rather than a re-encoding.
    expect(await readFile(join(outputDir, 'files/assay.csv'), 'utf8')).toBe('a,b\n1,2\n')
  })

  it('names a project that published nothing instead of reporting a generic failure', async () => {
    const storageRoot = await createScratch()
    const result = await ownerFor(storageRoot).exportProject(
      { projectId: 'project-1', destinationPath: join(storageRoot, 'crate') },
      SENDER
    )

    expect(result).toEqual({ ok: false, error: 'no-published-version' })
    await expect(stat(join(storageRoot, 'crate'))).rejects.toThrow()
  })

  it('names the versions it refused when nothing in the project could be exported', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-corrupt',
      filename: 'corrupt.csv',
      body: 'original\n',
      corruptBytes: 'tampered\n'
    })

    const result = await ownerFor(storageRoot).exportProject(
      { projectId: 'project-1', destinationPath: join(storageRoot, 'crate') },
      SENDER
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('no-exportable-version')
    expect(result.refused).toEqual([
      {
        appSessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-corrupt',
        reason: 'checksum-mismatch'
      }
    ])
  })

  it('answers project-not-found rather than exporting under an invented name', async () => {
    const storageRoot = await createScratch()
    const result = await ownerFor(storageRoot, { loadProject: async () => null }).exportProject(
      { projectId: 'gone', destinationPath: join(storageRoot, 'crate') },
      SENDER
    )

    expect(result).toEqual({ ok: false, error: 'project-not-found' })
  })

  it('treats a closed save sheet as a decision, not a failure', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      filename: 'assay.csv',
      body: 'a,b\n'
    })
    const showSaveDialog = async (): Promise<{ canceled: boolean; filePath: string }> => ({
      canceled: true,
      filePath: ''
    })

    const result = await ownerFor(storageRoot, { showSaveDialog }).exportProject(
      { projectId: 'project-1' },
      SENDER
    )

    expect(result).toEqual({ ok: false, error: 'cancelled' })
  })

  it('proposes a directory name derived from the project, and writes where the sheet points', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      filename: 'assay.csv',
      body: 'a,b\n'
    })
    const chosen = join(storageRoot, 'picked')
    let suggested: string | undefined
    const showSaveDialog = async (
      _sender: WebContents,
      options: { defaultPath?: string }
    ): Promise<{ canceled: boolean; filePath: string }> => {
      suggested = options.defaultPath
      return { canceled: false, filePath: chosen }
    }

    const result = await ownerFor(storageRoot, {
      showSaveDialog,
      // A title a path cannot hold must not decide whether the export works.
      loadProject: async (projectId) => ({
        id: projectId,
        name: 'Mpro 模拟/assay*',
        description: ''
      })
    }).exportProject({ projectId: 'project-1' }, SENDER)

    expect(suggested).toBe(join(storageRoot, 'Mpro 模拟_assay_-ro-crate'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outputDir).toBe(chosen)
    expect(await readFile(join(chosen, 'ro-crate-metadata.json'), 'utf8')).toContain(
      'Mpro 模拟/assay*'
    )
  })

  it('names an unwritable destination instead of a generic write failure', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      filename: 'assay.csv',
      body: 'a,b\n'
    })
    // A FILE where the crate directory should go: `mkdir` fails with ENOTDIR.
    const blocked = join(storageRoot, 'blocked')
    await writeFile(blocked, 'not a directory')

    const result = await ownerFor(storageRoot).exportProject(
      { projectId: 'project-1', destinationPath: blocked },
      SENDER
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('destination-unwritable')
  })

  it('reports a crate that failed its own validation as validation-failed, not as a write problem', async () => {
    const storageRoot = await createScratch()
    await writeDurableVersion({
      storageRoot,
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      filename: 'assay.csv',
      body: 'a,b\n'
    })

    const result = await ownerFor(storageRoot, {
      exportCrate: async () => {
        throw new RoCrateExportError(
          'RO-Crate validation failed: file-entities-typed-file (spec-must)'
        )
      }
    }).exportProject(
      { projectId: 'project-1', destinationPath: join(storageRoot, 'crate') },
      SENDER
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('validation-failed')
    expect(result.detail).toContain('file-entities-typed-file')
  })

  it('rejects a malformed request before touching the storage root', async () => {
    const storageRoot = await createScratch()
    await expect(ownerFor(storageRoot).exportProject({ projectId: '' }, SENDER)).rejects.toThrow(
      /Invalid RO-Crate export request/
    )
    await expect(
      ownerFor(storageRoot).exportProject({ projectId: 'project-1', destinationPath: '' }, SENDER)
    ).rejects.toThrow(/Invalid RO-Crate export request/)
  })
})
