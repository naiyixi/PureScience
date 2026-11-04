import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { exportCaseBundle } from './export-bundle'
import { packCaseArchive } from './marketplace'
import { publishCaseBundle } from './publish'
import type { CasePublishDependencies } from './publish'

// These tests run the publishing path against a fake GitHub that holds state: a release, its assets, and the index
// document those assets expose. The bundle writer and the archiver are the real ones, so the digest being published
// is computed from a real archive of a real bundle.

type FakeAsset = { id: number; name: string; content: string }

const makeGithub = (): {
  deps: (overrides?: Partial<CasePublishDependencies>) => CasePublishDependencies
  assets: Map<string, FakeAsset>
  calls: string[]
  setIndex: (document: string | null) => void
  digestOverride: { value: string | null }
} => {
  const assets = new Map<string, FakeAsset>()
  const calls: string[] = []
  let nextId = 100
  const digestOverride: { value: string | null } = { value: null }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const release = {
    id: 7,
    tag_name: 'case-index',
    upload_url:
      'https://uploads.github.com/repos/naiyixi/PureScience/releases/7/assets{?name,label}'
  }

  const fetchImpl = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push(`${method} ${url.host}${url.pathname}${url.search}`)

    if (url.host === 'uploads.github.com') {
      const name = url.searchParams.get('name') ?? 'unnamed'
      const content = String(init.body)
      const id = nextId++
      assets.set(name, { id, name, content })
      return json(
        {
          id,
          name,
          browser_download_url: `https://github.com/naiyixi/PureScience/releases/download/case-index/${name}`
        },
        201
      )
    }

    if (url.host !== 'api.github.com') {
      // Publishing must not depend on the public web host: record the call and fail loudly if it ever does.
      return new Response('the publisher must not depend on the web host', { status: 500 })
    }

    if (url.pathname.endsWith('/releases/tags/case-index')) return json(release)
    if (url.pathname.endsWith('/releases') && method === 'POST') return json(release, 201)
    if (url.pathname.includes('/releases/7/assets') && method === 'GET') {
      return json(
        [...assets.values()].map((asset) => ({
          id: asset.id,
          name: asset.name,
          browser_download_url: `https://github.com/naiyixi/PureScience/releases/download/case-index/${asset.name}`
        }))
      )
    }
    if (url.pathname.includes('/releases/assets/') && method === 'GET') {
      const id = Number(url.pathname.split('/').pop())
      for (const asset of assets.values()) {
        if (asset.id !== id) continue
        const content =
          digestOverride.value === null
            ? asset.content
            : asset.content.replace(
                /"bundleSha256": "[0-9a-f]+"/,
                `"bundleSha256": "${digestOverride.value}"`
              )
        return new Response(content, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }
    if (url.pathname.includes('/releases/assets/') && method === 'DELETE') {
      const id = Number(url.pathname.split('/').pop())
      for (const [name, asset] of assets) if (asset.id === id) assets.delete(name)
      // 204 cannot carry a body, and `new Response('')` refuses that status outright.
      return new Response(null, { status: 204 })
    }
    return new Response('unexpected', { status: 500 })
  }

  const deps = (overrides: Partial<CasePublishDependencies> = {}): CasePublishDependencies => ({
    // The real ones: a real bundle on disk, a real gzip archive, a real digest.
    exportBundle: exportCaseBundle,
    packArchive: packCaseArchive,
    readCredential: async () => 'ghp_test',
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => 1700000000000,
    ...overrides
  })

  return {
    deps,
    assets,
    calls,
    // Seeding the shelf means putting the index where it really lives: as an asset of the release.
    setIndex: (document) => {
      if (document === null) {
        assets.delete('case-marketplace.json')
        return
      }
      assets.set('case-marketplace.json', {
        id: nextId++,
        name: 'case-marketplace.json',
        content: document
      })
    },
    digestOverride
  }
}

const draft = {
  id: 'gpcr-activation',
  name: 'GPCR 激活途径：采样收敛与滞后审计',
  domain: 'structure',
  summary: '本机真实跑过的一个项目',
  author: 'naiyixi',
  license: 'MIT'
}

let dir = ''
let files: Array<{ name: string; sourcePath: string }> = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ps-publish-test-'))
  // Real bytes on disk: the bundle writer stats and hashes what it is given.
  const note = join(dir, 'notes.md')
  await writeFile(note, '# 真实项目\n')
  files = [{ name: 'notes.md', sourcePath: note }]
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('publishing one case', () => {
  it('uploads an archive, writes one entry, and reads the shelf back to prove it landed', async () => {
    const github = makeGithub()
    const outcome = await publishCaseBundle({ draft, files }, github.deps({ scratchRoot: dir }))

    expect(outcome.status).toBe('published')
    if (outcome.status !== 'published') return
    expect(outcome.verified).toBe(true)
    expect(outcome.fileCount).toBe(1)
    expect(outcome.bundleSha256).toMatch(/^[0-9a-f]{64}$/)
    // The archive went up under a name that carries the digest, and the index names that same digest.
    const archiveName = [...github.assets.keys()].find((name) =>
      name.startsWith('gpcr-activation-')
    )
    expect(archiveName, 'the archive is named after the digest it holds').toMatch(
      /^gpcr-activation-[0-9a-f]{16}\.tar\.gz$/
    )
    expect(archiveName).toContain(outcome.bundleSha256.slice(0, 16))
    const index = JSON.parse(github.assets.get('case-marketplace.json')?.content ?? '{}')
    expect(index.cases).toHaveLength(1)
    expect(index.cases[0]).toMatchObject({
      id: 'gpcr-activation',
      bundleSha256: outcome.bundleSha256,
      fileCount: 1
    })
  })

  it('leaves every other entry exactly as it found it', async () => {
    const github = makeGithub()
    github.setIndex(
      JSON.stringify({
        format: 'purescience.case-marketplace',
        version: 1,
        updatedAt: 5,
        cases: [
          {
            id: 'existing-one',
            name: '已有的案例',
            domain: 'general',
            summary: '别人的',
            author: 'someone',
            license: 'Apache-2.0',
            bundleUrl: 'https://github.com/x/y/releases/download/case-index/existing-one.tar.gz',
            bundleSha256: 'a'.repeat(64),
            fileCount: 3,
            totalBytes: 30,
            publishedAt: 1
          }
        ]
      })
    )

    const outcome = await publishCaseBundle({ draft, files }, github.deps({ scratchRoot: dir }))
    expect(outcome.status).toBe('published')

    const index = JSON.parse(github.assets.get('case-marketplace.json')?.content ?? '{}')
    expect(index.cases.map((entry: { id: string }) => entry.id)).toEqual([
      'existing-one',
      'gpcr-activation'
    ])
    expect(index.cases[0].bundleSha256).toBe('a'.repeat(64))
  })

  it('republishing the same id replaces that entry instead of adding a second one', async () => {
    const github = makeGithub()
    await publishCaseBundle({ draft, files }, github.deps({ scratchRoot: dir }))
    await publishCaseBundle(
      { draft: { ...draft, summary: '改过的说明' }, files },
      github.deps({ scratchRoot: dir })
    )

    const index = JSON.parse(github.assets.get('case-marketplace.json')?.content ?? '{}')
    expect(index.cases).toHaveLength(1)
    expect(index.cases[0].summary).toBe('改过的说明')
  })

  it('refuses when this machine holds no GitHub credential, and uploads nothing', async () => {
    const github = makeGithub()
    const outcome = await publishCaseBundle(
      { draft, files },
      github.deps({ scratchRoot: dir, readCredential: async () => null })
    )
    expect(outcome).toEqual({ status: 'refused', reason: 'no-credential', detail: 'gh auth login' })
    expect(github.calls).toHaveLength(0)
  })

  it('refuses an id that would not survive a URL', async () => {
    const github = makeGithub()
    const outcome = await publishCaseBundle(
      { draft: { ...draft, id: 'GPCR Activation!' }, files },
      github.deps({ scratchRoot: dir })
    )
    expect(outcome.status).toBe('refused')
    if (outcome.status === 'refused') expect(outcome.reason).toBe('bad-id')
  })

  it('refuses to publish with a blank summary rather than writing an empty card', async () => {
    const github = makeGithub()
    const outcome = await publishCaseBundle(
      { draft: { ...draft, summary: '   ' }, files },
      github.deps({ scratchRoot: dir })
    )
    expect(outcome.status).toBe('refused')
    if (outcome.status === 'refused') expect(outcome.reason).toBe('missing-metadata')
  })

  it('does not overwrite a shelf it cannot read', async () => {
    const github = makeGithub()
    github.setIndex('{"format":"something-else"}')

    const outcome = await publishCaseBundle({ draft, files }, github.deps({ scratchRoot: dir }))
    expect(outcome.status).toBe('refused')
    if (outcome.status === 'refused') expect(outcome.reason).toBe('index-unreadable')
    // The archive is already up; the index is untouched. That is the intended failure: a broken document is not
    // replaced with one we invented. Same asset, same bytes.
    expect(github.assets.get('case-marketplace.json')?.content).toBe('{"format":"something-else"}')
  })

  it('reports verify-failed when the published entry does not carry the digest we computed', async () => {
    const github = makeGithub()
    github.digestOverride.value = 'f'.repeat(64)

    const outcome = await publishCaseBundle({ draft, files }, github.deps({ scratchRoot: dir }))
    expect(outcome.status).toBe('refused')
    if (outcome.status === 'refused') {
      expect(outcome.reason).toBe('verify-failed')
      expect(outcome.detail).toBe('digest')
    }
  })

  it('refuses when the archive upload is rejected', async () => {
    const github = makeGithub()
    const deps = github.deps({ scratchRoot: dir })
    const outcome = await publishCaseBundle(
      { draft, files },
      {
        ...deps,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).includes('uploads.github.com'))
            return new Response('nope', { status: 422 })
          return deps.fetch(input as never, init)
        }) as unknown as typeof fetch
      }
    )
    expect(outcome.status).toBe('refused')
    if (outcome.status === 'refused') expect(outcome.reason).toBe('upload-failed')
  })

  it('refuses an empty project before it talks to the network at all', async () => {
    const github = makeGithub()
    const outcome = await publishCaseBundle({ draft, files: [] }, github.deps({ scratchRoot: dir }))
    expect(outcome.status).toBe('refused')
    if (outcome.status === 'refused') expect(outcome.reason).toBe('export-failed')
    expect(github.calls).toHaveLength(0)
  })
})
