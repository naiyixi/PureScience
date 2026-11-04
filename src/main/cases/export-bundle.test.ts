import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { validateCaseBundle } from '../../shared/case-bundle'
import {
  CASE_BUNDLE_FILES_DIR,
  CASE_BUNDLE_MANIFEST_NAME,
  CASE_BUNDLE_STAGING_PREFIX,
  caseBundleDirectoryName,
  exportCaseBundle,
  uniqueBundleDir
} from './export-bundle'

let root: string
let sources: string

const writeSource = async (name: string, content: string): Promise<string> => {
  const path = join(sources, name)
  await writeFile(path, content, 'utf8')
  return path
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'case-bundle-test-'))
  sources = join(root, 'sources')
  await writeFile(join(root, '.keep'), '', 'utf8')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(sources, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('case bundle export', () => {
  it('writes a manifest and the bytes, with checksums computed from what landed', async () => {
    const report = await writeSource('report.md', '# GPCR\n')
    const result = await exportCaseBundle({
      caseName: 'GPCR 激活途径',
      domain: 'structure',
      summary: '采样收敛与滞后审计',
      destinationDir: join(root, 'out'),
      files: [{ name: 'report.md', sourcePath: report, kind: 'md' }],
      createdAt: 1_700_000_000_000
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.fileCount).toBe(1)
    expect(result.totalBytes).toBe(7)
    const manifest = JSON.parse(
      await readFile(join(result.bundleDir, CASE_BUNDLE_MANIFEST_NAME), 'utf8')
    )
    // The bundle this module writes must be one the importer accepts unchanged.
    const checked = validateCaseBundle(manifest)
    expect(checked.ok).toBe(true)
    expect(manifest.files[0]).toMatchObject({ name: 'report.md', kind: 'md', sizeBytes: 7 })
    expect(await readFile(join(result.bundleDir, CASE_BUNDLE_FILES_DIR, 'report.md'), 'utf8')).toBe(
      '# GPCR\n'
    )
  })

  it('refuses a path in the file name instead of resolving it', async () => {
    const report = await writeSource('report.md', 'x')
    for (const name of ['../escape.md', 'nested/report.md', '..', '  ']) {
      expect(
        await exportCaseBundle({
          caseName: 'c',
          domain: 'general',
          destinationDir: join(root, 'out'),
          files: [{ name, sourcePath: report }]
        })
      ).toEqual({ ok: false, problem: 'bad-file-name', detail: name })
    }
    // Nothing was written for the refusals.
    expect(await readdir(join(root, 'out')).catch(() => [])).toEqual([])
  })

  it('stops before writing anything when a source is missing', async () => {
    const present = await writeSource('a.csv', 'a,b\n')
    const result = await exportCaseBundle({
      caseName: 'c',
      domain: 'general',
      destinationDir: join(root, 'out'),
      files: [
        { name: 'a.csv', sourcePath: present },
        { name: 'gone.csv', sourcePath: join(sources, 'gone.csv') }
      ]
    })
    expect(result).toEqual({ ok: false, problem: 'source-missing', detail: 'gone.csv' })
    expect(await readdir(join(root, 'out')).catch(() => [])).toEqual([])
  })

  it('refuses two names that differ only in case, and an empty list', async () => {
    const a = await writeSource('a.csv', 'a')
    expect(
      await exportCaseBundle({
        caseName: 'c',
        domain: 'general',
        destinationDir: join(root, 'out'),
        files: [
          { name: 'A.CSV', sourcePath: a },
          { name: 'a.csv', sourcePath: a }
        ]
      })
    ).toEqual({ ok: false, problem: 'duplicate-file-name', detail: 'a.csv' })
    expect(
      await exportCaseBundle({
        caseName: 'c',
        domain: 'general',
        destinationDir: join(root, 'out'),
        files: []
      })
    ).toEqual({ ok: false, problem: 'no-files' })
  })

  it('never overwrites a previous export of the same case', async () => {
    const report = await writeSource('report.md', 'one')
    const destinationDir = join(root, 'out')
    const first = await exportCaseBundle({
      caseName: 'Same case',
      domain: 'general',
      destinationDir,
      files: [{ name: 'report.md', sourcePath: report }]
    })
    expect(first.ok).toBe(true)
    const second = await exportCaseBundle({
      caseName: 'Same case',
      domain: 'general',
      destinationDir,
      files: [{ name: 'report.md', sourcePath: report }]
    })
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.bundleDir).not.toBe(first.bundleDir)
    expect(second.bundleDir.endsWith('Same case-2')).toBe(true)
    // The first bundle is untouched.
    expect(await readFile(join(first.bundleDir, CASE_BUNDLE_FILES_DIR, 'report.md'), 'utf8')).toBe(
      'one'
    )
  })

  it('leaves no staging directory behind on success', async () => {
    const report = await writeSource('report.md', 'x')
    const destinationDir = join(root, 'out')
    const result = await exportCaseBundle({
      caseName: 'clean',
      domain: 'general',
      destinationDir,
      files: [{ name: 'report.md', sourcePath: report }]
    })
    expect(result.ok).toBe(true)
    const entries = await readdir(destinationDir)
    expect(entries.filter((entry) => entry.startsWith(CASE_BUNDLE_STAGING_PREFIX))).toEqual([])
  })
})

describe('bundle naming', () => {
  it('keeps CJK and drops characters that are awkward in a path', () => {
    expect(caseBundleDirectoryName('GPCR 激活途径')).toBe('GPCR 激活途径')
    expect(caseBundleDirectoryName('a/b:c*d')).toBe('a-b-c-d')
    expect(caseBundleDirectoryName('   ')).toBe('case')
  })

  it('finds a free directory rather than reusing one', async () => {
    const destinationDir = join(root, 'free')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(destinationDir, 'case'), { recursive: true })
    expect(await uniqueBundleDir(destinationDir, 'case')).toBe(join(destinationDir, 'case-2'))
  })
})
