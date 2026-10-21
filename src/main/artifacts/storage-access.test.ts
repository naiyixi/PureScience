import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createArtifactDurability } from './durability'
import { runPendingFileTransaction } from './pending-file-transaction'
import {
  ArtifactStorageAccess,
  assertSafeFilename,
  createArtifactPublicationStorage,
  getArtifactMetadataPath,
  resolveAllowedImportFilePath
} from './storage-access'

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

// Field evidence, 2026-09 (the user's own run, from the app log): `write_artifact_file` failed with
//
//   ENAMETOOLONG: name too long, open '…/.pending/artifact-run-…/.metadata/%E5%9B%BA%E6%9C%89%E6%97%A0…'
//
// for a Chinese result title. The artifact name itself was 84 bytes — legal on every shipped platform —
// but the sidecar name percent-encoded the whole name, tripling each CJK byte, so it crossed the
// filesystem's 255-byte component limit and took the entire artifact write down with it. A reader sees
// only "write failed"; the file never lands, and nothing in the message says the title was the reason.
//
// The rule these cases pin: a name whose sidecar fits keeps the shipped scheme byte for byte (existing
// sidecars must keep resolving), and a name that would not fit gets a bounded, content-addressed sidecar
// instead of a filesystem error. The second half is not decoration — the write path also names its
// temporary and backup files after the sidecar, so a name that merely fits at 255 bytes still fails
// there; the accepted bound has to leave that room up front, with a message the writer can act on.
describe('artifact metadata sidecar names', () => {
  let root: string

  // 84 bytes as UTF-8, 30 characters as written: a realistic Chinese result title, legal as a filename.
  const LONG_CJK = '固有无序抗原构象熵冻结惩罚与折叠路径重加权分析结果报告终稿.csv'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ps-metadata-name-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps the shipped sidecar name for a name that fits', async () => {
    const storage = new ArtifactStorageAccess(root, createArtifactDurability())

    expect(getArtifactMetadataPath(root, 'plot.png')).toBe(join(root, '.metadata', 'plot.png.json'))

    await storage.writeArtifactMetadata(root, 'plot.png', { mimeType: 'image/png' })
    expect((await readdir(join(root, '.metadata'))).sort()).toEqual(['plot.png.json'])
  })

  it('bounds the sidecar for a long CJK title instead of tripling every byte', async () => {
    const path = getArtifactMetadataPath(root, LONG_CJK)
    const name = basename(path)

    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255)
    // Stable for the same name, distinct across names: the sidecar is addressed by content, not by a
    // truncation that two titles could share.
    expect(getArtifactMetadataPath(root, LONG_CJK)).toBe(path)
    expect(getArtifactMetadataPath(root, `${LONG_CJK}.bak`)).not.toBe(path)
  })

  it('round-trips metadata for a long CJK title through a real directory', async () => {
    const storage = new ArtifactStorageAccess(root, createArtifactDurability())
    const metadata = {
      mimeType: 'text/csv',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      versionNumber: 1,
      artifactRunId: 'run-1',
      checksum: 'a'.repeat(64)
    }

    await storage.writeArtifactMetadata(root, LONG_CJK, metadata)

    await expect(storage.readArtifactMetadata(root, LONG_CJK)).resolves.toEqual(metadata)
    const sidecarNames = await readdir(join(root, '.metadata'))
    expect(sidecarNames).toHaveLength(1)
    expect(Buffer.byteLength(sidecarNames[0] ?? '', 'utf8')).toBeLessThanOrEqual(255)
  })

  it('uses a bounded name when the encoded one would fit only without the write suffix', async () => {
    const storage = new ArtifactStorageAccess(root, createArtifactDurability())
    // Percent-encoding leaves ASCII alone, so this name's sidecar is 220 bytes: under the 255-byte
    // component limit, but the atomic write appends `.<uuid>.tmp` and would cross it. Before the rule
    // it failed inside the transaction with ENAMETOOLONG; it must now be written under a bounded name.
    const borderline = `${'a'.repeat(215)}.csv`
    expect(Buffer.byteLength(`${borderline}.json`, 'utf8')).toBeGreaterThan(214)

    await storage.writeArtifactMetadata(root, borderline, { mimeType: 'text/csv' })

    await expect(storage.readArtifactMetadata(root, borderline)).resolves.toEqual({
      mimeType: 'text/csv'
    })
    const name = basename(getArtifactMetadataPath(root, borderline))
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(214)
  })

  it('still reads a sidecar whose name the shipped scheme produced', async () => {
    const storage = new ArtifactStorageAccess(root, createArtifactDurability())
    await mkdir(join(root, '.metadata'), { recursive: true })
    await writeFile(
      join(root, '.metadata', `${encodeURIComponent('résumé — 终稿.csv')}.json`),
      JSON.stringify({ mimeType: 'text/csv', versionNumber: 2 })
    )

    await expect(storage.readArtifactMetadata(root, 'résumé — 终稿.csv')).resolves.toEqual({
      mimeType: 'text/csv',
      versionNumber: 2
    })
  })

  it('completes a pending write transaction for a long CJK title', async () => {
    const access = new ArtifactStorageAccess(root, createArtifactDurability())
    const publication = createArtifactPublicationStorage(access, async () => [])
    const storage = {
      ...publication,
      // The repository builds the published ArtifactFile in production; this case only needs the write
      // transaction to reach its end, so the double echoes the request fields back.
      createArtifactFile: async (request: {
        projectName: string
        sessionId: string
        filename: string
        filePath: string
        mimeType?: string
        runId?: string
      }) => ({
        id: 'artifact-1',
        projectName: request.projectName,
        sessionId: request.sessionId,
        runId: request.runId,
        name: request.filename,
        path: request.filePath,
        fileUrl: `file://${request.filePath}`,
        mimeType: request.mimeType,
        size: 8,
        mtimeMs: 0
      })
    }

    const published = await runPendingFileTransaction<string, never>({
      request: {
        projectName: 'project-1',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: LONG_CJK,
        mimeType: 'text/csv',
        source: { kind: 'inline', content: 'a,b\n1,2\n', encoding: 'utf8' }
      },
      writeOptions: {},
      storage,
      publishRouting: async () => undefined,
      operation: async (artifact) => artifact.name
    })

    expect(published).toBe(LONG_CJK)
    const pendingDir = access.getPendingRunDir('project-1', 'session-1', 'run-1')
    // No `.tmp` / `.backup` residue: the transaction's own suffixed names have to fit beside the
    // payload, which is why the accepted bound reserves room for them.
    const entries = await readdir(pendingDir)
    expect(entries).toContain(LONG_CJK)
    expect(entries.filter((name) => /\.(tmp|backup)$/.test(name))).toEqual([])
    await expect(access.readArtifactMetadata(pendingDir, LONG_CJK)).resolves.toEqual({
      mimeType: 'text/csv'
    })
  })

  it('accepts a title that fits and refuses one that cannot be written, naming the bound', () => {
    expect(assertSafeFilename(LONG_CJK)).toBe(LONG_CJK)
    expect(assertSafeFilename('a'.repeat(191))).toBe('a'.repeat(191))

    expect(() => assertSafeFilename('a'.repeat(192))).toThrow(/too long.*192 bytes.*191/s)
    // The reader has to be able to act on it: the message keeps the name (bounded) and the limit.
    expect(() => assertSafeFilename(`${'固'.repeat(80)}.csv`)).toThrow(/固/)
    expect(() => assertSafeFilename('../escape.csv')).toThrow(/Invalid artifact filename/)
  })
})
