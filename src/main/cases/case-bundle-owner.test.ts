import { describe, expect, it, vi } from 'vitest'

import type {
  CaseBundleFileEnumerator,
  CaseBundleReader,
  CaseBundleWriter,
  CaseBundlePathResolver
} from './case-bundle-owner'
import { createCaseBundleCommandOwner } from './case-bundle-owner'

const manifest = {
  format: 'purescience.case-bundle' as const,
  version: 1,
  name: 'GPCR 激活途径',
  domain: 'structure',
  createdAt: 1,
  files: [{ name: 'report.md', kind: 'md', sizeBytes: 7, sha256: 'a'.repeat(64) }]
}

const owner = (overrides: {
  write?: CaseBundleWriter
  read?: CaseBundleReader
  resolvePath?: CaseBundlePathResolver
  enumerate?: CaseBundleFileEnumerator
  materialise?: (
    bundleDir: string,
    targetDir: string
  ) => Promise<
    | { ok: true; directory: string; fileCount: number; totalBytes: number }
    | { ok: false; problem: 'incomplete'; detail?: string }
  >
}): {
  write: CaseBundleWriter
  read: CaseBundleReader
  resolvePath: CaseBundlePathResolver
  enumerate: CaseBundleFileEnumerator
  materialise: (
    bundleDir: string,
    targetDir: string
  ) => Promise<
    | { ok: true; directory: string; fileCount: number; totalBytes: number }
    | { ok: false; problem: 'incomplete'; detail?: string }
  >
  commands: ReturnType<typeof createCaseBundleCommandOwner>
} => {
  const write: CaseBundleWriter =
    overrides.write ??
    vi.fn(async () => ({ ok: true as const, bundleDir: '/out/case', fileCount: 1, totalBytes: 7 }))
  const read: CaseBundleReader = overrides.read ?? vi.fn()
  const resolvePath: CaseBundlePathResolver =
    overrides.resolvePath ?? vi.fn(async ({ path }: { path: string }) => `/abs/${path}`)
  const enumerate: CaseBundleFileEnumerator =
    overrides.enumerate ?? vi.fn(async () => ({ ok: true as const, files: [] }))
  const materialise =
    overrides.materialise ??
    (async (_bundleDir: string, targetDir: string) => ({
      ok: true as const,
      directory: targetDir,
      fileCount: 1,
      totalBytes: 7
    }))
  return {
    write,
    read,
    resolvePath,
    enumerate,
    materialise,
    commands: createCaseBundleCommandOwner({ write, read, resolvePath, enumerate, materialise })
  }
}

const file = (
  name: string,
  path: string = name
): { name: string; source: 'upload'; path: string } => ({ name, source: 'upload', path })

describe('case bundle export command', () => {
  it('resolves every name through the shared resolver before writing', async () => {
    const { commands, write, resolvePath } = owner({})
    const result = await commands.export({
      projectId: 'p1',
      caseName: manifest.name,
      domain: 'structure',
      destinationDir: '/out',
      files: [file('report.md', 'uploads/report.md'), { ...file('b.csv'), projectId: 'p1' }]
    })
    expect(result).toEqual({
      status: 'exported',
      bundleDir: '/out/case',
      fileCount: 1,
      totalBytes: 7
    })
    expect(resolvePath).toHaveBeenNthCalledWith(1, {
      source: 'upload',
      path: 'uploads/report.md',
      projectId: 'p1'
    })
    // Optional scope keys are passed through when present and omitted when not — never undefined.
    expect(resolvePath).toHaveBeenNthCalledWith(2, {
      source: 'upload',
      path: 'b.csv',
      projectId: 'p1'
    })
    expect(write).toHaveBeenCalledWith({
      caseName: manifest.name,
      domain: 'structure',
      destinationDir: '/out',
      files: [
        { name: 'report.md', sourcePath: '/abs/uploads/report.md' },
        { name: 'b.csv', sourcePath: '/abs/b.csv' }
      ]
    })
  })

  it('refuses the whole export when the resolver will not vouch for one file', async () => {
    const resolvePath = vi.fn(async ({ path }: { path: string }) => {
      if (path === 'secret.csv') throw new Error('outside the workspace')
      return `/abs/${path}`
    })
    const { commands, write } = owner({ resolvePath })
    const result = await commands.export({
      projectId: 'p1',
      caseName: 'c',
      domain: 'general',
      destinationDir: '/out',
      files: [file('a.csv'), file('secret.csv')]
    })
    expect(result).toEqual({
      status: 'refused',
      reason: 'unreadable',
      detail: 'outside the workspace'
    })
    // Nothing was written: a bundle with a hole is worse than no bundle.
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses an empty file list without asking the resolver anything', async () => {
    const { commands, resolvePath } = owner({})
    expect(
      await commands.export({
        projectId: 'p1',
        caseName: 'c',
        domain: 'general',
        destinationDir: '/out',
        files: []
      })
    ).toEqual({ status: 'refused', reason: 'no-files' })
    expect(resolvePath).not.toHaveBeenCalled()
  })

  it('carries the writer’s reason and detail through instead of flattening it', async () => {
    const write: CaseBundleWriter = vi.fn(async () => ({
      ok: false as const,
      problem: 'duplicate-file-name' as const,
      detail: 'a.csv'
    }))
    const { commands } = owner({ write })
    expect(
      await commands.export({
        projectId: 'p1',
        caseName: 'c',
        domain: 'general',
        destinationDir: '/out',
        files: [file('a.csv')]
      })
    ).toEqual({ status: 'refused', reason: 'duplicate-file-name', detail: 'a.csv' })
  })
})

describe('export by project id', () => {
  it('asks the main process for the project’s files when the window names none', async () => {
    const enumerate = vi.fn(async () => ({
      ok: true as const,
      files: [
        { name: 'report.md', source: 'artifact' as const, path: 'v1/report.md', kind: 'md' },
        { name: 'scan.png', source: 'upload' as const, path: 'uploads/scan.png' }
      ]
    }))
    const { commands, write } = owner({ enumerate })
    const result = await commands.export({
      projectId: 'p1',
      caseName: 'c',
      domain: 'general',
      destinationDir: '/out'
    })
    expect(result).toMatchObject({ status: 'exported' })
    expect(enumerate).toHaveBeenCalledWith('p1')
    // The project id travels with each file: an enumerated file belongs to the project being exported.
    expect(write).toHaveBeenCalledWith({
      caseName: 'c',
      domain: 'general',
      destinationDir: '/out',
      files: [
        { name: 'report.md', sourcePath: '/abs/v1/report.md', kind: 'md' },
        { name: 'scan.png', sourcePath: '/abs/uploads/scan.png' }
      ]
    })
  })

  it('refuses when the project has nothing to hand over, and says nothing was written', async () => {
    const { commands, write } = owner({
      enumerate: vi.fn(async () => ({ ok: true as const, files: [] }))
    })
    expect(
      await commands.export({
        projectId: 'p1',
        caseName: 'c',
        domain: 'general',
        destinationDir: '/out'
      })
    ).toEqual({ status: 'refused', reason: 'no-files' })
    expect(write).not.toHaveBeenCalled()
  })

  it('carries the catalogue’s own failure instead of exporting a partial case', async () => {
    const { commands, write } = owner({
      enumerate: vi.fn(async () => ({ ok: false as const, detail: 'index unreadable' }))
    })
    expect(
      await commands.export({
        projectId: 'p1',
        caseName: 'c',
        domain: 'general',
        destinationDir: '/out'
      })
    ).toEqual({ status: 'refused', reason: 'unreadable', detail: 'index unreadable' })
    expect(write).not.toHaveBeenCalled()
  })
})

describe('case bundle import command', () => {
  it('reports what it read, including the manifest the window renders', async () => {
    const read: CaseBundleReader = vi.fn(async () => ({
      ok: true as const,
      bundle: { manifest, totalBytes: 7 }
    }))
    const { commands } = owner({ read })
    expect(await commands.import({ bundleDir: '/in/case' })).toEqual({
      status: 'imported',
      name: manifest.name,
      domain: 'structure',
      fileCount: 1,
      totalBytes: 7,
      manifest
    })
    expect(read).toHaveBeenCalledWith('/in/case')
  })

  it('copies the verified bytes only when a destination was asked for', async () => {
    const read: CaseBundleReader = vi.fn(async () => ({
      ok: true as const,
      bundle: { manifest, totalBytes: 7 }
    }))
    const materialise = vi.fn(async (_dir: string, target: string) => ({
      ok: true as const,
      directory: target,
      fileCount: 1,
      totalBytes: 7
    }))
    const { commands } = owner({ read, materialise })
    expect(
      await commands.import({ bundleDir: '/in/case', materialiseTo: '/chosen' })
    ).toMatchObject({
      status: 'imported',
      materialisedTo: '/chosen'
    })
    expect(materialise).toHaveBeenCalledWith('/in/case', '/chosen')
  })

  it('reports a failed copy as a refusal, not as an import that half happened', async () => {
    const read: CaseBundleReader = vi.fn(async () => ({
      ok: true as const,
      bundle: { manifest, totalBytes: 7 }
    }))
    const materialise = vi.fn(async () => ({
      ok: false as const,
      problem: 'incomplete' as const,
      detail: 'report.md'
    }))
    const { commands } = owner({ read, materialise })
    expect(await commands.import({ bundleDir: '/in/case', materialiseTo: '/chosen' })).toEqual({
      status: 'refused',
      reason: 'incomplete',
      detail: 'report.md'
    })
  })

  it('passes the reconciliation detail through, so the window can list the offending names', async () => {
    const read: CaseBundleReader = vi.fn(async () => ({
      ok: false as const,
      problem: 'incomplete' as const,
      problematic: { missing: ['report.md'], checksumMismatch: [], unexpected: ['x.exe'] }
    }))
    const { commands } = owner({ read })
    expect(await commands.import({ bundleDir: '/in/bad' })).toEqual({
      status: 'refused',
      reason: 'incomplete',
      problematic: { missing: ['report.md'], checksumMismatch: [], unexpected: ['x.exe'] }
    })
  })
})
