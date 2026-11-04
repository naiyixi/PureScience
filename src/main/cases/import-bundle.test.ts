import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { exportCaseBundle } from './export-bundle'
import { importCaseBundle, materialiseCaseBundle } from './import-bundle'

let root: string
let sources: string

const writeSource = async (name: string, content: string): Promise<string> => {
  const path = join(sources, name)
  await writeFile(path, content, 'utf8')
  return path
}

// Builds a real bundle with the exporter, so the importer is exercised against bytes this repo actually wrote
// rather than a hand-rolled fixture that could drift from the writer.
const buildBundle = async (
  files: Array<{ name: string; content: string }> = [{ name: 'report.md', content: '# x\n' }]
): Promise<string> => {
  const sourceFiles = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      sourcePath: await writeSource(`${Date.now()}-${file.name}`, file.content)
    }))
  )
  const result = await exportCaseBundle({
    caseName: 'round trip',
    domain: 'general',
    destinationDir: join(root, 'bundles'),
    files: sourceFiles
  })
  if (!result.ok) throw new Error(`export failed: ${result.problem} ${result.detail ?? ''}`)
  return result.bundleDir
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'case-import-test-'))
  sources = join(root, 'sources')
  await mkdir(sources, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('case bundle import', () => {
  it('accepts what the exporter wrote, with the manifest and verified paths', async () => {
    const dir = await buildBundle([
      { name: 'report.md', content: '# x\n' },
      { name: 'figure.png', content: 'binary-ish' }
    ])
    const result = await importCaseBundle(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bundle.manifest.name).toBe('round trip')
    expect(result.bundle.files.map((file) => file.name)).toEqual(['figure.png', 'report.md'])
    expect(result.bundle.totalBytes).toBe(4 + 10)
    // The paths handed on point inside the bundle's files directory.
    for (const file of result.bundle.files)
      expect(file.path.startsWith(join(dir, 'files'))).toBe(true)
  })

  it('refuses a bundle whose bytes changed after the manifest was written', async () => {
    const dir = await buildBundle()
    await writeFile(join(dir, 'files', 'report.md'), '# tampered\n', 'utf8')
    const result = await importCaseBundle(dir)
    expect(result).toMatchObject({
      ok: false,
      problem: 'incomplete',
      problematic: { missing: [], checksumMismatch: ['report.md'], unexpected: [] }
    })
  })

  it('refuses a bundle carrying a file the manifest never described', async () => {
    const dir = await buildBundle()
    await writeFile(join(dir, 'files', 'stowaway.exe'), 'x', 'utf8')
    const result = await importCaseBundle(dir)
    expect(result).toMatchObject({
      ok: false,
      problem: 'incomplete',
      problematic: { missing: [], checksumMismatch: [], unexpected: ['stowaway.exe'] }
    })
  })

  it('names a file the manifest promised but the bundle lacks', async () => {
    const dir = await buildBundle()
    await rm(join(dir, 'files', 'report.md'))
    const result = await importCaseBundle(dir)
    expect(result).toMatchObject({
      ok: false,
      problem: 'incomplete',
      problematic: { missing: ['report.md'], checksumMismatch: [], unexpected: [] }
    })
  })

  it('refuses a manifest that asks to write outside the bundle directory', async () => {
    const dir = await buildBundle()
    const manifestPath = join(dir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.files = [{ name: '../../escape.md', kind: 'md', sizeBytes: 1, sha256: 'a'.repeat(64) }]
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
    expect(await importCaseBundle(dir)).toEqual({
      ok: false,
      problem: 'bad-file-name',
      detail: '../../escape.md'
    })
  })

  it('separates "not a bundle" from "a bundle that does not add up"', async () => {
    const missingManifest = join(root, 'empty')
    await mkdir(missingManifest, { recursive: true })
    expect(await importCaseBundle(missingManifest)).toEqual({
      ok: false,
      problem: 'manifest-missing'
    })
    expect(await importCaseBundle(join(root, 'nope'))).toEqual({
      ok: false,
      problem: 'not-a-directory'
    })

    const brokenJson = join(root, 'broken')
    await mkdir(join(brokenJson, 'files'), { recursive: true })
    await writeFile(join(brokenJson, 'manifest.json'), '{', 'utf8')
    expect(await importCaseBundle(brokenJson)).toMatchObject({
      ok: false,
      problem: 'manifest-unreadable'
    })

    const foreign = join(root, 'foreign')
    await mkdir(join(foreign, 'files'), { recursive: true })
    await writeFile(
      join(foreign, 'manifest.json'),
      JSON.stringify({ format: 'other', version: 1, name: 'x', files: [] }),
      'utf8'
    )
    expect(await importCaseBundle(foreign)).toMatchObject({
      ok: false,
      problem: 'invalid-bundle',
      detail: 'unknown-format'
    })
  })
})

describe('materialising a bundle', () => {
  it('copies only after the whole bundle verifies', async () => {
    const dir = await buildBundle()
    const target = join(root, 'materialised')
    const result = await materialiseCaseBundle(dir, target)
    expect(result).toMatchObject({ ok: true, fileCount: 1 })
    expect(await readFile(join(target, 'report.md'), 'utf8')).toBe('# x\n')
  })

  it('copies nothing when the bundle does not verify', async () => {
    const dir = await buildBundle()
    await writeFile(join(dir, 'files', 'stowaway.exe'), 'x', 'utf8')
    const target = join(root, 'materialised-bad')
    const result = await materialiseCaseBundle(dir, target)
    expect(result).toMatchObject({ ok: false, problem: 'incomplete' })
    // Not even the verified files were copied.
    expect(await rm(target, { recursive: true, force: true }).then(() => 'cleaned')).toBe('cleaned')
    expect(await readFile(join(target, 'report.md'), 'utf8').catch(() => 'absent')).toBe('absent')
  })
})
