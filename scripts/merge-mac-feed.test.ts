import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildMacFeedText,
  inspectMacFeed,
  parseMacFeed,
  resolveMacFeedInputs,
  runMergeMacFeedCli,
  sha512Base64
} from './merge-mac-feed.mjs'

// The real published v1.75.0 mac feed, verbatim (`gh release download v1.75.0 --pattern
// latest-mac.yml`). This is the artifact issue #18 is about: electron-builder's build-time feed for
// ONE arch (the x64 one — its `releaseDate` is the x64 packaging run's) that the silent merge passed
// through untouched, so every Apple Silicon client polls a feed with no arm64 entry.
const PUBLISHED_V1750_FEED = `version: 1.75.0
files:
  - url: zerolink-purescience-1.75.0-mac-x64.zip
    sha512: cWbE4Xb1sVjd7BcHncVY6JRf3JrCFcpPISJebwfgwZO5jdGyTM9D6vQd8kKxZLiPXj35INED1LcqihpDi1Gy2g==
    size: 295342638
  - url: zerolink-purescience-1.75.0-mac-x64.dmg
    sha512: Q03sHLQbXvFEGj7ui9k1HzPpOojOYk1PZDm8NwuSpt+/ghKi+NL7J56FGOVXzbk+kn0E0mWU/Q/KB1E2g/IERQ==
    size: 295480088
path: zerolink-purescience-1.75.0-mac-x64.zip
sha512: cWbE4Xb1sVjd7BcHncVY6JRf3JrCFcpPISJebwfgwZO5jdGyTM9D6vQd8kKxZLiPXj35INED1LcqihpDi1Gy2g==
releaseDate: '2026-09-28T09:58:19.561Z'
`

// Real published values for that zip: 295,342,638 bytes, and a sha512 whose base64 form was
// re-derived locally from the downloaded asset (`shasum -a 512 -b | xxd -r -p | base64` matches this
// string), i.e. this is the byte-level digest electron-updater verifies, not a placeholder.
const REAL_X64_SHA512 =
  'cWbE4Xb1sVjd7BcHncVY6JRf3JrCFcpPISJebwfgwZO5jdGyTM9D6vQd8kKxZLiPXj35INED1LcqihpDi1Gy2g=='
const REAL_X64_SIZE = 295342638
const ARM64_ZIP = 'zerolink-purescience-1.75.0-mac-arm64.zip'
const X64_ZIP = 'zerolink-purescience-1.75.0-mac-x64.zip'

// notarize-mac.yml's per-arch intermediate for the x64 arm, in its exact emitted shape.
const PER_ARCH_X64_FEED = `version: 1.75.0
files:
  - url: ${X64_ZIP}
    sha512: ${REAL_X64_SHA512}
    size: ${REAL_X64_SIZE}
path: ${X64_ZIP}
sha512: ${REAL_X64_SHA512}
releaseDate: "2026-09-28T09:58:19.561Z"
`

const tempDirs: string[] = []
const makeDir = (files: Record<string, string> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-mac-feed-'))
  tempDirs.push(dir)
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
  return dir
}
const readFeed = (dir: string): string => readFileSync(join(dir, 'latest-mac.yml'), 'utf8')
const independentSha512 = (path: string): string =>
  createHash('sha512').update(readFileSync(path)).digest('base64')

// The CLI's real exit code, from a real process (not the in-process return value): the release gate
// is judged on `$?`, so that is the contract worth pinning.
const runCli = (args: string[]): { status: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync('node', ['scripts/merge-mac-feed.mjs', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8'
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? ''
    }
  }
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

describe('resolveMacFeedInputs', () => {
  it('derives each arch entry from the published zip bytes', async () => {
    const dir = makeDir({ [ARM64_ZIP]: 'arm64 bytes', [X64_ZIP]: 'x64 bytes' })
    const { version, entries, problems } = await resolveMacFeedInputs(dir)

    expect(problems).toEqual([])
    expect(version).toBe('1.75.0')
    for (const [arch, zip] of [
      ['arm64', ARM64_ZIP],
      ['x64', X64_ZIP]
    ] as const) {
      expect(entries[arch].url).toBe(zip)
      expect(entries[arch].sha512).toBe(independentSha512(join(dir, zip)))
      expect(entries[arch].size).toBe(
        Buffer.byteLength(zip === ARM64_ZIP ? 'arm64 bytes' : 'x64 bytes')
      )
      expect(entries[arch].source).toBe(`bytes of ${zip}`)
    }
  })

  it('completes from the per-arch feed when only one arch zip is present', async () => {
    // The v1.75.0 shape minus the collision: the arm64 zip is there, the x64 material only as the
    // feed notarize-mac.yml would have written. The merged feed must still name both arches.
    const dir = makeDir({ [ARM64_ZIP]: 'arm64 bytes', 'x64-mac.yml': PER_ARCH_X64_FEED })
    const { entries, problems } = await resolveMacFeedInputs(dir)

    expect(problems).toEqual([])
    expect(entries.x64).toMatchObject({
      url: X64_ZIP,
      sha512: REAL_X64_SHA512,
      size: REAL_X64_SIZE,
      source: 'x64-mac.yml'
    })
    expect(entries.arm64.source).toBe(`bytes of ${ARM64_ZIP}`)
  })

  it('names every architecture it cannot resolve', async () => {
    const dir = makeDir()
    const { entries, problems } = await resolveMacFeedInputs(dir)

    expect(entries).toEqual({})
    expect(problems).toEqual([
      `arm64: no *-mac-arm64.zip in ${dir} and no arm64-mac.yml to fall back to`,
      `x64: no *-mac-x64.zip in ${dir} and no x64-mac.yml to fall back to`,
      `could not read a release version from the mac artifact names in ${dir}`
    ])
  })

  it('rejects a per-arch feed that carries no complete zip entry', async () => {
    const dir = makeDir({
      [ARM64_ZIP]: 'arm64 bytes',
      'x64-mac.yml': `version: 1.75.0\nfiles:\n  - url: ${X64_ZIP}\n    sha512: ${REAL_X64_SHA512}\n`
    })
    const { problems } = await resolveMacFeedInputs(dir)

    expect(problems).toEqual([
      'x64: x64-mac.yml carries no complete -mac-x64.zip entry (url + sha512 + size)'
    ])
  })

  it('rejects a stale per-arch feed that names a different version', async () => {
    const dir = makeDir({
      [ARM64_ZIP]: 'arm64 bytes',
      'x64-mac.yml': PER_ARCH_X64_FEED.replace(/1\.75\.0/g, '1.74.0')
    })
    const { problems } = await resolveMacFeedInputs(dir)

    expect(problems).toContain('version mismatch across the mac artifacts: 1.74.0 vs 1.75.0')
  })
})

describe('the generated feed', () => {
  it('lists both arch zips with a sha512 and a size, arm64 first', async () => {
    const dir = makeDir({ [ARM64_ZIP]: 'arm64 bytes', [X64_ZIP]: 'x64 bytes' })
    const { version, entries, problems } = await resolveMacFeedInputs(dir)
    expect(problems).toEqual([])

    const text = buildMacFeedText({ version, entries, releaseDate: '2026-09-29T00:00:00.000Z' })
    const parsed = load(text) as {
      version: string
      files: { url: string; sha512: string; size: number }[]
      path: string
      releaseDate: string
    }

    expect(parsed.version).toBe('1.75.0')
    expect(parsed.files.map((file) => file.url)).toEqual([ARM64_ZIP, X64_ZIP])
    for (const file of parsed.files) {
      expect(file.sha512).toHaveLength(88)
      expect(Number.isSafeInteger(file.size) && file.size > 0).toBe(true)
    }
    // electron-updater's own size lookup (src/main/update/electron-updater-strategy.ts) matches the
    // single `.zip` whose url carries the arch token — so exactly one zip per arch is what it needs.
    expect(
      parsed.files.filter((file) => file.url.includes('arm64') && file.url.endsWith('.zip'))
    ).toHaveLength(1)
    expect(parsed.path).toBe(ARM64_ZIP)
    expect(parsed.releaseDate).toBe('2026-09-29T00:00:00.000Z')
  })

  it('is byte-identical for the same inputs', async () => {
    const dir = makeDir({ [ARM64_ZIP]: 'arm64 bytes', [X64_ZIP]: 'x64 bytes' })
    const { version, entries } = await resolveMacFeedInputs(dir)
    const once = buildMacFeedText({ version, entries, releaseDate: '2026-09-29T00:00:00.000Z' })
    const twice = buildMacFeedText({ version, entries, releaseDate: '2026-09-29T00:00:00.000Z' })

    expect(once).toBe(twice)
  })
})

describe('inspectMacFeed (the release gate)', () => {
  it('passes on a feed built from both arch zips', async () => {
    const dir = makeDir({ [ARM64_ZIP]: 'arm64 bytes', [X64_ZIP]: 'x64 bytes' })
    await runMergeMacFeedCli([dir], { log: () => {}, error: () => {}, write: () => {} })

    const { problems, entries } = await inspectMacFeed(readFeed(dir), dir)
    expect(problems).toEqual([])
    expect(Object.keys(entries).sort()).toEqual(['arm64', 'x64'])
  })

  it('fails on the real published v1.75.0 feed, naming the missing architecture', async () => {
    const dir = makeDir({ 'latest-mac.yml': PUBLISHED_V1750_FEED })
    const { problems, entries } = await inspectMacFeed(readFeed(dir), dir)

    expect(entries.x64.url).toBe(X64_ZIP)
    expect(problems).toEqual([
      'no -mac-arm64.zip entry (an installed arm64 app cannot update from this feed)'
    ])
  })

  it('fails when an entry lacks a size, a sha512, or has one that is not a digest', async () => {
    const dir = makeDir({
      'latest-mac.yml': `version: 1.75.0
files:
  - url: ${ARM64_ZIP}
    sha512: ${REAL_X64_SHA512}
  - url: ${X64_ZIP}
    sha512: not-a-digest
    size: 12
`
    })
    const { problems } = await inspectMacFeed(readFeed(dir), dir)

    expect(problems).toEqual([
      `arm64: entry ${ARM64_ZIP} has no valid size`,
      `x64: entry ${X64_ZIP} has no valid sha512`
    ])
  })

  it('fails when the feed does not agree with the zip bytes on disk', async () => {
    const dir = makeDir({ [ARM64_ZIP]: 'arm64 bytes', [X64_ZIP]: 'x64 bytes' })
    await runMergeMacFeedCli([dir], { log: () => {}, error: () => {}, write: () => {} })
    expect((await inspectMacFeed(readFeed(dir), dir)).problems).toEqual([])

    // Repackaged zip (what notarization does): the feed's recorded digest is now stale.
    const restaped = 'arm64 bytes, re-stapled'
    writeFileSync(join(dir, ARM64_ZIP), restaped)
    const { problems } = await inspectMacFeed(readFeed(dir), dir)

    expect(problems).toEqual([
      `arm64: feed sha512 does not match ${ARM64_ZIP} on disk`,
      `arm64: feed size ${Buffer.byteLength('arm64 bytes')} != ${ARM64_ZIP} (${Buffer.byteLength(restaped)} bytes)`
    ])
  })
})

describe('runMergeMacFeedCli', () => {
  it('writes the merged feed and reports the per-arch source', async () => {
    const dir = makeDir({ [ARM64_ZIP]: 'arm64 bytes', 'x64-mac.yml': PER_ARCH_X64_FEED })
    const lines: string[] = []
    const status = await runMergeMacFeedCli([dir], {
      log: (line) => lines.push(line),
      error: () => {},
      write: () => {}
    })

    expect(status).toBe(0)
    expect(lines).toContain(`merge-mac-feed: arm64 from bytes of ${ARM64_ZIP}`)
    expect(lines).toContain('merge-mac-feed: x64 from x64-mac.yml')
    expect(readFeed(dir)).toContain(`size: ${REAL_X64_SIZE}`)
  })

  it('refuses to write a feed that names only one architecture', async () => {
    const dir = makeDir({ [ARM64_ZIP]: 'arm64 bytes' })
    const errors: string[] = []
    const status = await runMergeMacFeedCli([dir], {
      log: () => {},
      error: (line) => errors.push(line)
    })

    expect(status).toBe(1)
    expect(errors[0]).toBe(
      `::error::refusing to write ${join(dir, 'latest-mac.yml')} without both architectures:`
    )
    expect(errors.some((line) => line.includes('x64: no *-mac-x64.zip'))).toBe(true)
    expect(() => readFeed(dir)).toThrow()
  })

  it('keeps a repair backfill a no-op only when there is no mac material at all', async () => {
    const empty = makeDir()
    const partial = makeDir({ [ARM64_ZIP]: 'arm64 bytes' })
    const quiet = { log: () => {}, error: () => {}, write: () => {} }

    expect(await runMergeMacFeedCli([empty, '--allow-missing'], quiet)).toBe(0)
    expect(await runMergeMacFeedCli([partial, '--allow-missing'], quiet)).toBe(1)
  })

  it('exits non-zero on a partial feed through a real process', () => {
    const dir = makeDir({ [ARM64_ZIP]: 'arm64 bytes', 'latest-mac.yml': PUBLISHED_V1750_FEED })

    const status = runCli([dir, '--verify'])
    expect(status.status).toBe(1)
    expect(status.stderr).toContain('::error::mac update feed')
    expect(status.stderr).toContain('no -mac-arm64.zip entry')

    const complete = makeDir({ [ARM64_ZIP]: 'arm64 bytes', [X64_ZIP]: 'x64 bytes' })
    expect(runCli([complete])).toMatchObject({ status: 0 })
    expect(runCli([complete, '--verify'])).toMatchObject({ status: 0 })
    // A missing feed is a failure too, not a silent pass.
    expect(runCli([makeDir(), '--verify']).status).toBe(1)
  })
})

describe('parseMacFeed', () => {
  it("reads electron-builder's build-time feed without leaking the top-level sha512", () => {
    // electron-builder lists the zip and the dmg; the legacy top-level `sha512:` after the block
    // belongs to the FIRST entry, so a naive scan would overwrite the dmg entry with it.
    const { version, entries } = parseMacFeed(PUBLISHED_V1750_FEED)

    expect(version).toBe('1.75.0')
    expect(entries).toEqual([
      { url: X64_ZIP, sha512: REAL_X64_SHA512, size: REAL_X64_SIZE },
      {
        url: 'zerolink-purescience-1.75.0-mac-x64.dmg',
        sha512:
          'Q03sHLQbXvFEGj7ui9k1HzPpOojOYk1PZDm8NwuSpt+/ghKi+NL7J56FGOVXzbk+kn0E0mWU/Q/KB1E2g/IERQ==',
        size: 295480088
      }
    ])
  })

  it('reads a regenerated per-arch feed (no dmg, double-quoted date)', () => {
    const { version, releaseDate, entries } = parseMacFeed(PER_ARCH_X64_FEED)

    expect(version).toBe('1.75.0')
    expect(releaseDate).toBe('2026-09-28T09:58:19.561Z')
    expect(entries).toEqual([{ url: X64_ZIP, sha512: REAL_X64_SHA512, size: REAL_X64_SIZE }])
  })

  it('hashes the bytes it is given rather than trusting a filename', async () => {
    const dir = makeDir({ [X64_ZIP]: 'x64 bytes' })
    expect(await sha512Base64(join(dir, X64_ZIP))).toBe(independentSha512(join(dir, X64_ZIP)))
    expect(await sha512Base64(join(dir, X64_ZIP))).not.toBe(REAL_X64_SHA512)
  })
})

describe('release wiring', () => {
  type Step = { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }
  type Job = { steps?: Step[]; needs?: string | string[] }
  const workflow = (name: string): { jobs: Record<string, Job> } =>
    load(readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8')) as {
      jobs: Record<string, Job>
    }
  const step = (job: Job, name: string): Step => {
    const found = job.steps?.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`missing step: ${name}`)
    return found
  }

  it('gates the release on a feed that names both architectures', () => {
    const publish = workflow('release.yml').jobs.publish
    const merge = step(publish, 'Merge mac update feed')
    const gate = step(publish, 'Gate the mac update feed on both architectures')

    expect(merge.run).toBe('node scripts/merge-mac-feed.mjs artifacts')
    expect(gate.run).toBe('node scripts/merge-mac-feed.mjs artifacts --verify')
    // Fail-closed: an accidental continue-on-error would let the broken feed ship.
    expect(gate['continue-on-error']).toBeUndefined()
    expect(gate.if).toBeUndefined()
    const names = publish.steps?.map((candidate) => candidate.name) ?? []
    expect(names.indexOf(merge.name as string)).toBeLessThan(names.indexOf(gate.name as string))
    // The gate must run before anything is uploaded to the Release.
    expect(names.indexOf(gate.name as string)).toBeLessThan(names.indexOf('Publish GitHub Release'))
  })

  it('names the build-time mac feed per architecture so the two artifacts cannot collide', () => {
    const rename = step(
      workflow('build.yml').jobs.build,
      'Name the macOS update feed by architecture'
    )

    expect(rename.if).toBe("${{ matrix.platform == 'mac' }}")
    expect(rename.run).toContain('mv "$feed" "dist/${{ matrix.bin_arch }}-mac.yml"')
  })

  it('lets only the standalone repair path skip an absent feed', () => {
    const refresh = workflow('notarize-mac.yml').jobs['refresh-checksums']
    const merge = step(refresh, 'Merge + upload latest-mac.yml')

    expect(merge.run).toContain('node scripts/merge-mac-feed.mjs "$dir" --allow-missing')
  })
})
