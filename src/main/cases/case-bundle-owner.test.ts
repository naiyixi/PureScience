import { describe, expect, it, vi } from 'vitest'

import type {
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
}): {
  write: CaseBundleWriter
  read: CaseBundleReader
  resolvePath: CaseBundlePathResolver
  commands: ReturnType<typeof createCaseBundleCommandOwner>
} => {
  const write: CaseBundleWriter =
    overrides.write ??
    vi.fn(async () => ({ ok: true as const, bundleDir: '/out/case', fileCount: 1, totalBytes: 7 }))
  const read: CaseBundleReader = overrides.read ?? vi.fn()
  const resolvePath: CaseBundlePathResolver =
    overrides.resolvePath ?? vi.fn(async ({ path }: { path: string }) => `/abs/${path}`)
  return {
    write,
    read,
    resolvePath,
    commands: createCaseBundleCommandOwner({ write, read, resolvePath })
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
      path: 'uploads/report.md'
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
        caseName: 'c',
        domain: 'general',
        destinationDir: '/out',
        files: [file('a.csv')]
      })
    ).toEqual({ status: 'refused', reason: 'duplicate-file-name', detail: 'a.csv' })
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
