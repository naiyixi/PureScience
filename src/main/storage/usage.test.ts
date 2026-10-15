import { chmod, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { availableBytes, computeStorageUsage, dirSize, measureDirectorySize } from './usage'

let dataRoot: string

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'ds-usage-'))
})

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true })
})

// Writes a file of exactly `bytes` size at `path`, creating parent dirs as needed.
const writeSized = async (path: string, bytes: number): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes))
}

describe('computeStorageUsage', () => {
  it('sums per-category bytes and gives runtime a sorted children breakdown', async () => {
    await writeSized(join(dataRoot, 'artifacts', 'a.bin'), 100)
    await writeSized(join(dataRoot, 'uploads', 'b.bin'), 50)
    await writeSized(join(dataRoot, 'workspaces', 'session-1', 'repo', 'data.bin'), 25)
    await writeSized(join(dataRoot, 'runtime', 'python', 'p.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'r', 'r.bin'), 300)
    // notebooks/ left absent.

    const usage = await computeStorageUsage(dataRoot)

    expect(usage.categories).toEqual([
      { key: 'artifacts', bytes: 100 },
      { key: 'uploads', bytes: 50 },
      {
        key: 'runtime',
        bytes: 500,
        children: [
          { name: 'r', bytes: 300 },
          { name: 'python', bytes: 200 }
        ]
      },
      { key: 'notebooks', bytes: 0 },
      { key: 'workspaces', bytes: 25 }
    ])
    expect(usage.totalBytes).toBe(675)
  })

  it('labels default-python/-r as python/r and the shared pkgs cache as conda', async () => {
    await writeSized(join(dataRoot, 'runtime', 'envs', 'default-python', 'p.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'envs', 'default-r', 'r.bin'), 300)
    await writeSized(join(dataRoot, 'runtime', 'envs', 'my-analysis', 'm.bin'), 50)
    await writeSized(join(dataRoot, 'runtime', 'pkgs', 'cache.bin'), 400)

    const usage = await computeStorageUsage(dataRoot)
    const runtime = usage.categories.find((c) => c.key === 'runtime')

    expect(runtime).toEqual({
      key: 'runtime',
      bytes: 950,
      children: [
        { name: 'conda', bytes: 400 },
        { name: 'r', bytes: 300 },
        { name: 'python', bytes: 200 },
        { name: 'my-analysis', bytes: 50 }
      ]
    })
  })

  it('labels reserved short default directories by their logical environment', async () => {
    await writeSized(join(dataRoot, 'runtime', 'envs', '.p', 'p.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'envs', '.r', 'r.bin'), 300)

    const usage = await computeStorageUsage(dataRoot)
    const runtime = usage.categories.find((category) => category.key === 'runtime')

    expect(runtime?.children).toEqual([
      { name: 'r', bytes: 300 },
      { name: 'python', bytes: 200 }
    ])
  })

  it('combines inert legacy residue with the active short default in one usage row', async () => {
    await writeSized(join(dataRoot, 'runtime', 'envs', '.p', 'short.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'envs', 'default-python', 'legacy.bin'), 50)

    const usage = await computeStorageUsage(dataRoot)
    const runtime = usage.categories.find((category) => category.key === 'runtime')

    expect(runtime?.children).toEqual([{ name: 'python', bytes: 250 }])
  })

  it('counts envs.lock toward the runtime total but does not show it as its own row', async () => {
    await writeSized(join(dataRoot, 'runtime', 'envs', 'default-python', 'p.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'envs.lock', 'default-r.lock'), 10)

    const usage = await computeStorageUsage(dataRoot)
    const runtime = usage.categories.find((c) => c.key === 'runtime')

    expect(runtime?.children?.map((c) => c.name)).toEqual(['python'])
    // 200 (python) + 10 (hidden envs.lock) still in the total.
    expect(runtime?.bytes).toBe(210)
  })

  // Hard links (inode dedup) are Unix-only; Windows stat ino isn't reliable for this.
  it.skipIf(process.platform === 'win32')(
    'counts a package hard-linked from pkgs into an env once (attributed to conda, not the env)',
    async () => {
      // The shared package lives in the cache; the env hard-links it (as micromamba does) + 24B unique.
      await writeSized(join(dataRoot, 'runtime', 'pkgs', 'libbig.bin'), 1000)
      await mkdir(join(dataRoot, 'runtime', 'envs', 'default-r', 'lib'), { recursive: true })
      await link(
        join(dataRoot, 'runtime', 'pkgs', 'libbig.bin'),
        join(dataRoot, 'runtime', 'envs', 'default-r', 'lib', 'libbig.bin')
      )
      await writeSized(join(dataRoot, 'runtime', 'envs', 'default-r', 'unique.bin'), 24)

      const usage = await computeStorageUsage(dataRoot)
      const runtime = usage.categories.find((c) => c.key === 'runtime')

      // conda counts the shared 1000B once; r shows only its 24B unique; total = 1024 (matches `du`).
      expect(runtime).toEqual({
        key: 'runtime',
        bytes: 1024,
        children: [
          { name: 'conda', bytes: 1000 },
          { name: 'r', bytes: 24 }
        ]
      })
    }
  )

  it('includes loose top-level files under runtime alongside its subdirectory children', async () => {
    await writeSized(join(dataRoot, 'runtime', 'python', 'p.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'lockfile'), 10)

    const usage = await computeStorageUsage(dataRoot)
    const runtime = usage.categories.find((c) => c.key === 'runtime')

    expect(runtime).toEqual({
      key: 'runtime',
      bytes: 210,
      children: [{ name: 'python', bytes: 200 }]
    })
  })

  it('reports what hard links saved instead of only the smaller total', async () => {
    const first = join(dataRoot, 'uploads', 'project', 'session', 'one.bin')
    const second = join(dataRoot, 'uploads', 'project', 'session', 'two.bin')
    await writeSized(first, 4096)
    await link(first, second)

    const usage = await computeStorageUsage(dataRoot)

    // Two names, one copy: the total counts the bytes once, and the size the second name would have added
    // is reported as the saving — read off the same walk, so the two numbers cannot disagree.
    expect(usage.totalBytes).toBe(4096)
    expect(usage.sharedBytes).toBe(4096)
    expect(usage.sharedFiles).toBe(1)
  })

  it('tolerates an empty or missing data root without throwing', async () => {
    const missingRoot = join(dataRoot, 'does-not-exist')

    const usage = await computeStorageUsage(missingRoot)

    expect(usage.categories).toEqual([
      { key: 'artifacts', bytes: 0 },
      { key: 'uploads', bytes: 0 },
      { key: 'runtime', bytes: 0, children: [] },
      { key: 'notebooks', bytes: 0 },
      { key: 'workspaces', bytes: 0 }
    ])
    expect(usage.totalBytes).toBe(0)
  })
})

describe('directory size measurement: a failed look is not zero bytes (P0-10)', () => {
  it('measures a readable tree and reports a measured zero for a path that is not there', async () => {
    await writeSized(join(dataRoot, 'tree', 'a.bin'), 10)
    await writeSized(join(dataRoot, 'tree', 'sub', 'b.bin'), 5)

    await expect(measureDirectorySize(join(dataRoot, 'tree'), new Set())).resolves.toEqual({
      state: 'measured',
      bytes: 15
    })
    // Not there ⇒ nothing was there. That is a reading (0), not a missing one.
    await expect(measureDirectorySize(join(dataRoot, 'never-existed'), new Set())).resolves.toEqual(
      {
        state: 'measured',
        bytes: 0
      }
    )
  })

  it('answers unavailable/unreadable for a path that exists but cannot be listed', async () => {
    // A file where a directory is expected: `readdir` fails with ENOTDIR on every platform, which is the
    // "we could not look" state — the number nobody measured must not be reported as 0.
    const path = join(dataRoot, 'not-a-directory')
    await writeFile(path, 'x')

    await expect(measureDirectorySize(path, new Set())).resolves.toEqual({
      state: 'unavailable',
      reason: 'unreadable'
    })
    // The lenient walker keeps its documented policy: a whole-tree total counts an unlistable directory as
    // 0 rather than failing (one unreadable subdirectory must not blank a storage category).
    await expect(dirSize(path, new Set())).resolves.toBe(0)
  })

  // Directory permissions are POSIX-only (Windows chmod only touches the read-only bit), so the nested case
  // is skipped there instead of asserted through a no-op chmod.
  it.skipIf(process.platform === 'win32')(
    'answers unavailable when only a nested directory cannot be listed (a partial tree is not a reading)',
    async () => {
      const root = join(dataRoot, 'partial')
      await writeSized(join(root, 'readable.bin'), 7)
      const sealed = join(root, 'sealed')
      await mkdir(sealed, { recursive: true })
      await writeFile(join(sealed, 'hidden.bin'), Buffer.alloc(4096))
      await chmod(sealed, 0o000)

      try {
        // 7 is not the answer: that tree holds at least 4,103 bytes. Reporting the partial sum would show a
        // smaller number as if it were the whole prefix.
        await expect(measureDirectorySize(root, new Set())).resolves.toEqual({
          state: 'unavailable',
          reason: 'unreadable'
        })
        await expect(dirSize(root, new Set())).resolves.toBe(7)
      } finally {
        await chmod(sealed, 0o700)
      }
    }
  )
})

describe('availableBytes', () => {
  it('returns a positive finite number for an existing path', async () => {
    const bytes = await availableBytes(tmpdir())

    expect(Number.isFinite(bytes)).toBe(true)
    expect(bytes).toBeGreaterThan(0)
  })
})

describe('per-project attribution (optional input, no database dependency here)', () => {
  it('reports both rows when asked, without changing the category walk', async () => {
    await mkdir(join(dataRoot, 'notebooks', 'p1'), { recursive: true })
    await writeFile(join(dataRoot, 'notebooks', 'p1', 'run.json'), Buffer.alloc(600, 1))
    await mkdir(join(dataRoot, 'artifacts', 'p1'), { recursive: true })
    await writeFile(join(dataRoot, 'artifacts', 'p1', 'model.pt'), Buffer.alloc(400, 1))
    await mkdir(join(dataRoot, 'notebooks', 'p2'), { recursive: true })
    await writeFile(join(dataRoot, 'notebooks', 'p2', 'run.json'), Buffer.alloc(100, 1))

    const withProjects = await computeStorageUsage(dataRoot, [
      { id: 'p1', name: 'Mpro docking' },
      { id: 'p2', name: 'GSE331003' }
    ])
    const withoutProjects = await computeStorageUsage(dataRoot)

    expect(withProjects.projects).toEqual([
      { id: 'p1', name: 'Mpro docking', bytes: 1000 },
      { id: 'p2', name: 'GSE331003', bytes: 100 }
    ])
    // Absent means the caller did not ask — never "no project uses space".
    expect(withoutProjects.projects).toBeUndefined()
    expect(withProjects.categories).toEqual(withoutProjects.categories)
    expect(withProjects.totalBytes).toBe(withoutProjects.totalBytes)
  })

  it('names no rows for a project whose directories are gone', async () => {
    const usage = await computeStorageUsage(dataRoot, [{ id: 'never-existed', name: 'x' }])

    expect(usage.projects).toEqual([{ id: 'never-existed', name: 'x', bytes: 0 }])
  })
})
