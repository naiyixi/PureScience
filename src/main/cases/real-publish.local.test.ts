import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { exportCaseBundle } from './export-bundle'
import { packCaseArchive, unpackCaseArchive } from './marketplace'
import { publishCaseBundle, readGitHubCredential } from './publish'

// Real machine, real network, real release.
//
// Run explicitly: VITEST_LOCAL=1 npx vitest run src/main/cases/real-publish.local.test.ts
//
// It publishes a project that exists on this machine to the live `case-index` release, then reads the shelf back
// over the API and compares the archive it finds against the source files on disk. Two things it refuses to do:
// touch the public web host (github.com is the slow route from here and the publish path does not need it), and
// call anything a mock.

const OWNER = 'naiyixi'
const REPO = 'PureScience'
const TAG = 'case-index'

const SOURCE_DIR =
  process.env.PS_REAL_CASE_DIR ??
  '/Users/totota/.purescience/artifacts/cmvceawow0000wf81cnzqbjx2/6bbdd2d2-3bbb-4e5a-aeb5-dc53652b6588/message-1792250831378-6'

const deps = {
  exportBundle: exportCaseBundle,
  packArchive: packCaseArchive,
  readCredential: readGitHubCredential,
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now()
}

const token = async (): Promise<string> => {
  const { stdout } = await promisify(execFile)('gh', ['auth', 'token'])
  return stdout.trim()
}

const apiJson = async <T>(path: string, auth: string): Promise<T> => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json' }
  })
  if (!response.ok) throw new Error(`${path} -> ${response.status}`)
  return (await response.json()) as T
}

type Asset = { id: number; name: string }

const release = async (auth: string): Promise<{ id: number; assets: Asset[] }> => {
  const found = await apiJson<{ id: number }>(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, auth)
  const assets = await apiJson<Asset[]>(`/repos/${OWNER}/${REPO}/releases/${found.id}/assets`, auth)
  return { id: found.id, assets }
}

const downloadAsset = async (id: number, destination: string, auth: string): Promise<void> => {
  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${id}`,
    { headers: { authorization: `Bearer ${auth}`, accept: 'application/octet-stream' } }
  )
  if (!response.ok) throw new Error(`asset ${id} -> ${response.status}`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

const bundleFilesDir = async (unpackedInto: string): Promise<string> => {
  const entries = await readdir(unpackedInto, { withFileTypes: true })
  const bundle = entries.find((entry) => entry.isDirectory())
  if (!bundle) throw new Error('the archive carried no bundle directory')
  return join(unpackedInto, bundle.name, 'files')
}

describe('publishing against the live release', () => {
  it('publishes a real project and the shelf serves those bytes back', async () => {
    const auth = await token()
    const names = (await readdir(SOURCE_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
    expect(names.length, 'the source project must be on this machine').toBeGreaterThan(0)

    const draft = {
      id: 'internal-evaluation',
      name: '内部评测：多组学异常到首次人体试验',
      domain: 'general',
      summary: '从多组学异常出发，走到首次人体试验的完整复现文件（真实项目，非示例）',
      author: 'naiyixi',
      license: 'MIT'
    }

    const outcome = await publishCaseBundle(
      {
        draft,
        files: names.map((name) => ({ name, sourcePath: join(SOURCE_DIR, name) }))
      },
      deps
    )
    expect(outcome).toMatchObject({ status: 'published', verified: true })
    if (outcome.status !== 'published') return
    console.log(
      `PUBLISHED ${outcome.id}: ${outcome.fileCount} files, ${outcome.totalBytes} bytes, ` +
        `digest ${outcome.bundleSha256.slice(0, 12)}, archive ${outcome.archiveBytes} bytes`
    )

    // What the release holds now: an index naming this digest, and an archive named after it.
    const after = await release(auth)
    const indexAsset = after.assets.find((asset) => asset.name === 'case-marketplace.json')
    expect(indexAsset, 'the index must be on the release').toBeTruthy()
    const indexFile = join(tmpdir(), `ps-index-${Date.now()}.json`)
    await downloadAsset(indexAsset!.id, indexFile, auth)
    const index = JSON.parse(await readFile(indexFile, 'utf8'))
    const landed = index.cases.find((entry: { id: string }) => entry.id === draft.id)
    expect(landed.bundleSha256).toBe(outcome.bundleSha256)
    expect(landed.fileCount).toBe(names.length)
    expect(index.cases.filter((entry: { id: string }) => entry.id === draft.id)).toHaveLength(1)

    const archiveName = landed.bundleUrl.split('/').pop() as string
    expect(archiveName).toContain(outcome.bundleSha256.slice(0, 16))

    // And the bytes behind that entry are the bytes on disk here.
    const work = await mkdtemp(join(tmpdir(), 'ps-real-publish-'))
    try {
      const archive = join(work, 'landed.tar.gz')
      const archiveAsset = after.assets.find((asset) => asset.name === archiveName)
      expect(archiveAsset, 'the archive the index names must be downloadable').toBeTruthy()
      await downloadAsset(archiveAsset!.id, archive, auth)

      const unpacked = await unpackCaseArchive(archive, join(work, 'unpacked'))
      expect(unpacked.ok).toBe(true)
      if (!unpacked.ok) return
      const filesDir = await bundleFilesDir(unpacked.directory)
      const unpackedFiles = await readdir(filesDir)
      expect(unpackedFiles.sort()).toEqual(names)
      for (const name of names) {
        const [onDisk, fromArchive] = await Promise.all([
          readFile(join(SOURCE_DIR, name)),
          readFile(join(filesDir, name))
        ])
        expect(fromArchive.equals(onDisk), `${name} differs`).toBe(true)
      }
    } finally {
      await rm(work, { recursive: true, force: true })
      await rm(indexFile, { force: true })
    }
  }, 900_000)
})
