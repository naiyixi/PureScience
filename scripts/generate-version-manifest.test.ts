import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildManifest,
  extractHighlights,
  manifestNotes,
  NOTES_FALLBACK,
  parseSha256Sums,
  resolveManifestOptions,
  resolveVersion,
  VERSION_PATTERN
} from './generate-version-manifest.mjs'
import { selectDownload } from '../src/shared/update'

const VERSION = '0.1.2'
const CDN = 'https://cdn.example.com'
const PREFIX = 'purescience'

// The full set of installer filenames a complete release produces (matches electron-builder.yml
// artifactName templates with the zerolink- prefix). The linux AppImage carries `x86_64` because
// electron-builder substitutes the packaging arch there — every published release names it that way
// (v1.75.0 … v2.27.0), and a near-miss here is silent: the file only warns as "unrecognized".
const INSTALLERS = {
  'mac-arm64': `zerolink-purescience-${VERSION}-mac-arm64.dmg`,
  'mac-x64': `zerolink-purescience-${VERSION}-mac-x64.dmg`,
  'win-x64': `zerolink-purescience-${VERSION}-win-x64-setup.exe`,
  'linux-x64-appimage': `zerolink-purescience-${VERSION}-linux-x86_64.AppImage`,
  'linux-x64-deb': `zerolink-purescience_${VERSION}_amd64.deb`
}

// One line of SHA256SUMS.txt worth of file: content is hashed by `sha` (or omitted when sha is null).
type FileSpec = { name: string; content: string; sha: string | null }

// Builds a hermetic release directory: writes each given file with deterministic contents and a
// matching SHA256SUMS.txt. Contents/hashes are arbitrary but fixed, so assertions stay stable.
function makeReleaseDir(files: FileSpec[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'version-manifest-'))
  const sumsLines: string[] = []
  for (const { name, content, sha } of files) {
    writeFileSync(join(dir, name), content)
    if (sha !== null) sumsLines.push(`${sha}  ${name}`)
  }
  writeFileSync(join(dir, 'SHA256SUMS.txt'), `${sumsLines.join('\n')}\n`)
  return dir
}

// A canonical entry: 64-hex sha keyed off the platform so each file gets a distinct, checkable hash.
const HEX = (n: string): string => n.repeat(64)
function entry(key: keyof typeof INSTALLERS, extra = 0): FileSpec {
  return { name: INSTALLERS[key], content: 'x'.repeat(10 + extra), sha: HEX(String(extra % 10)) }
}

// `Object.keys` widens the platform literals to `string`; narrow them back by *checking* membership
// rather than asserting it, so a renamed platform literal surfaces as a failing count assertion below
// instead of an argument the compiler was told to trust.
const installerKeys = (): (keyof typeof INSTALLERS)[] =>
  Object.keys(INSTALLERS).filter((key): key is keyof typeof INSTALLERS => key in INSTALLERS)

describe('parseSha256Sums', () => {
  it('parses `<hex>  <filename>` lines and lowercases the hash', () => {
    const map = parseSha256Sums(
      `${'A'.repeat(64)}  file-one.dmg\n${'b'.repeat(64)}  file two.exe\n`
    )
    expect(map['file-one.dmg']).toBe('a'.repeat(64))
    expect(map['file two.exe']).toBe('b'.repeat(64))
  })

  it('tolerates the optional binary-mode `*` marker and ignores junk lines', () => {
    const map = parseSha256Sums(`${'c'.repeat(64)} *app.AppImage\nnot a checksum line\n`)
    expect(map['app.AppImage']).toBe('c'.repeat(64))
    expect(Object.keys(map)).toHaveLength(1)
  })
})

describe('extractHighlights', () => {
  const body = [
    '# PureScience v0.2.0',
    '',
    '> one-line tagline',
    '',
    'Intro paragraph.',
    '',
    '## ✨ Highlights',
    '',
    '- Point one (#1)',
    '- Point two',
    '',
    '## 🚀 New Features',
    '',
    '- Feature A',
    '',
    '## 🔧 Improvements',
    '',
    '- Improvement A',
    '',
    '## 🐛 Bug Fixes',
    '',
    '- Fix A',
    '',
    '## 📦 Install',
    '',
    'Download the build for your platform.',
    '',
    "## What's Changed",
    '',
    '- chore: bump deps'
  ].join('\n')

  it('keeps only the allowlisted sections, in document order', () => {
    const notes = extractHighlights(body)

    expect(notes).toContain('## ✨ Highlights')
    expect(notes).toContain('## 🚀 New Features')
    expect(notes).toContain('## 🔧 Improvements')
    expect(notes).toContain('## 🐛 Bug Fixes')
    // Dropped sections and their content.
    expect(notes).not.toContain('## 📦 Install')
    expect(notes).not.toContain('Download the build')
    expect(notes).not.toContain("What's Changed")
    expect(notes).not.toContain('bump deps')
    // Order preserved.
    expect(notes.indexOf('Highlights')).toBeLessThan(notes.indexOf('Bug Fixes'))
  })

  it('returns an empty string for an empty or blank body', () => {
    expect(extractHighlights('')).toBe('')
    expect(extractHighlights('   \n  \n')).toBe('')
    expect(extractHighlights(undefined)).toBe('')
  })

  it('falls back to the preamble (minus the H1 title) when no allowlisted section exists', () => {
    const plain = '# Title\n\n> tagline\n\nSome intro without standard sections.'
    const notes = extractHighlights(plain)

    expect(notes).not.toContain('# Title')
    expect(notes).toContain('tagline')
    expect(notes).toContain('Some intro without standard sections.')
  })
})

describe('buildManifest', () => {
  let dir: string | undefined
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('maps every installer to its key with url, size and sha256', () => {
    const files = installerKeys().map((key, i) => entry(key, i + 1))
    dir = makeReleaseDir(files)

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: 'Release notes here',
      releaseDate: '2026-07-12T00:00:00Z',
      cdnBase: CDN,
      prefix: PREFIX
    })

    // version / notes / releaseDate pass through untouched.
    expect(manifest.version).toBe(VERSION)
    expect(manifest.notes).toBe('Release notes here')
    expect(manifest.releaseDate).toBe('2026-07-12T00:00:00Z')

    // All five platform keys present.
    expect(Object.keys(manifest.downloads).sort()).toEqual(Object.keys(INSTALLERS).sort())

    // url construction: <cdn>/<prefix>/releases/<version>/<filename>.
    expect(manifest.downloads['win-x64'].url).toBe(
      `${CDN}/${PREFIX}/releases/${VERSION}/${INSTALLERS['win-x64']}`
    )
    // deb keeps the underscore/amd64 convention in its url.
    expect(manifest.downloads['linux-x64-deb'].url).toBe(
      `${CDN}/${PREFIX}/releases/${VERSION}/zerolink-purescience_${VERSION}_amd64.deb`
    )

    // sha256 comes from SHA256SUMS.txt (entry #2 -> content length 12, sha of '2').
    const deb = files.find((f) => f.name === INSTALLERS['linux-x64-deb'])
    // Named, not read past: a fixture that stopped producing this entry would otherwise fail as a
    // TypeError on `undefined`, which reads like a broken test rather than a changed fixture.
    if (!deb) throw new Error('the fixture produced no linux-x64-deb entry')
    expect(manifest.downloads['linux-x64-deb'].sha256).toBe(deb.sha)
    expect(manifest.downloads['linux-x64-deb'].size).toBe(deb.content.length)
  })

  // The defect this pins (published v2.27.0): INSTALLERS asked for `-linux-x64.AppImage` while every
  // release ships `-linux-x86_64.AppImage`, so the manifest shipped without the AppImage key and the
  // client's linux fallback in selectDownload could never fire. The near-miss old name must stay
  // unrecognized — otherwise the fix would accept both spellings and the typo would survive.
  it('keys the linux AppImage by the name electron-builder actually writes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = makeReleaseDir([
      entry('linux-x64-appimage', 1),
      { name: `zerolink-purescience-${VERSION}-linux-x64.AppImage`, content: 'old', sha: HEX('2') }
    ])

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: '',
      releaseDate: '',
      cdnBase: CDN,
      prefix: PREFIX
    })

    expect(manifest.downloads['linux-x64-appimage'].url).toBe(
      `${CDN}/${PREFIX}/releases/${VERSION}/zerolink-purescience-${VERSION}-linux-x86_64.AppImage`
    )
    // Only one entry: the mis-spelled name was not silently accepted as the same key.
    expect(Object.keys(manifest.downloads)).toEqual(['linux-x64-appimage'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('linux-x64.AppImage'))
    warn.mockRestore()
  })

  // Producer -> consumer: the manifest this script writes is the one the app reads. With the deb
  // absent, the client must fall back to the AppImage — the branch that was unreachable while the
  // producer never emitted that key.
  it('produces a manifest the client can fall back to the AppImage from', () => {
    dir = makeReleaseDir([entry('linux-x64-appimage', 3)])

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: '',
      releaseDate: '',
      cdnBase: CDN,
      prefix: PREFIX
    })

    expect(manifest.downloads['linux-x64-deb']).toBeUndefined()
    const picked = selectDownload(manifest, 'linux', 'x64')
    expect(picked?.url).toContain('linux-x86_64.AppImage')
  })

  it('keeps a single slash when the mirror has no path prefix', () => {
    dir = makeReleaseDir([entry('mac-arm64', 1)])

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: '',
      releaseDate: '',
      cdnBase: CDN,
      prefix: ''
    })

    expect(manifest.downloads['mac-arm64'].url).toBe(
      `${CDN}/releases/${VERSION}/${INSTALLERS['mac-arm64']}`
    )
    expect(manifest.downloads['mac-arm64'].url).not.toContain('//releases')
  })

  it('omits a platform whose installer is missing', () => {
    dir = makeReleaseDir([entry('mac-arm64', 1), entry('win-x64', 2)])

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: '',
      releaseDate: '',
      cdnBase: CDN,
      prefix: PREFIX
    })

    expect(Object.keys(manifest.downloads).sort()).toEqual(['mac-arm64', 'win-x64'])
    expect(manifest.downloads['mac-x64']).toBeUndefined()
    expect(manifest.downloads['linux-x64-deb']).toBeUndefined()
  })

  it('warns and skips an installer missing from SHA256SUMS', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = makeReleaseDir([entry('mac-arm64', 1), { ...entry('mac-x64', 2), sha: null }])

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: '',
      releaseDate: '',
      cdnBase: CDN,
      prefix: PREFIX
    })

    expect(manifest.downloads['mac-arm64']).toBeDefined()
    expect(manifest.downloads['mac-x64']).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no sha256'))
    warn.mockRestore()
  })

  it('warns on an unrecognized file but stays silent for zips and checksums', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = makeReleaseDir([
      entry('mac-arm64', 1),
      { name: 'zerolink-purescience-0.1.2-mac-arm64.zip', content: 'zip', sha: HEX('9') },
      { name: 'mystery-artifact.bin', content: 'bin', sha: HEX('8') }
    ])

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: '',
      releaseDate: '',
      cdnBase: CDN,
      prefix: PREFIX
    })

    // zip is mirrored to S3 but is not a manifest key.
    expect(manifest.downloads['mac-arm64']).toBeDefined()
    expect(Object.keys(manifest.downloads)).toEqual(['mac-arm64'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mystery-artifact.bin'))
    warn.mockRestore()
  })
})

describe('manifestNotes', () => {
  const withTempChangelog = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-notes-'))
    writeFileSync(join(dir, 'CHANGELOG.md'), body)
    return join(dir, 'CHANGELOG.md')
  }

  it('carries the entry body for the version, without the entry heading', () => {
    const path = withTempChangelog(
      [
        '## v1.2.3 — 2026-01-01（标题）',
        '',
        '**要点**',
        '',
        '- 细节',
        '',
        '## v1.2.2 — 2026-01-01（旧）',
        '',
        '旧正文',
        ''
      ].join('\n')
    )

    expect(manifestNotes('1.2.3', path)).toBe('**要点**\n\n- 细节')
  })

  it('falls back to the GitHub link when the changelog has no entry for the version', () => {
    const path = withTempChangelog('## v1.0.0 — 2026-01-01（x）\n\n正文\n')
    expect(manifestNotes('9.9.9', path)).toBe(NOTES_FALLBACK)
  })

  it('falls back when the changelog cannot be read', () => {
    expect(manifestNotes('1.2.3', join(tmpdir(), 'absent-changelog-dir', 'CHANGELOG.md'))).toBe(
      NOTES_FALLBACK
    )
  })

  it('carries the shipped entry for a released version straight from the repository changelog', () => {
    // Not a fixture: the manifest generated for a real release must carry the same entry the release
    // page shows, so the two cannot disagree.
    const notes = manifestNotes('1.68.0')
    expect(notes).not.toBe(NOTES_FALLBACK)
    expect(notes.startsWith('## v')).toBe(false)
    expect(notes.length).toBeGreaterThan(200)
  })
})

describe('resolveVersion', () => {
  it('prefers the explicit argument, which is how the publish job states the release tag', () => {
    expect(resolveVersion('1.76.1', { GITHUB_REF_NAME: 'main' })).toBe('1.76.1')
  })

  it('strips a leading v from every source', () => {
    expect(resolveVersion('v1.76.1', {})).toBe('1.76.1')
    expect(resolveVersion(undefined, { RELEASE_TAG: 'v1.76.1' })).toBe('1.76.1')
    expect(resolveVersion(undefined, { GITHUB_REF_NAME: 'v1.76.1' })).toBe('1.76.1')
  })

  // The bug this pins: a manual publish builds the branch (`main`), so the ref name is NOT the
  // version — the tag the Release is created under is.
  it('prefers RELEASE_TAG over GITHUB_REF_NAME when the built ref is not the release tag', () => {
    expect(resolveVersion(undefined, { GITHUB_REF_NAME: 'main', RELEASE_TAG: 'v1.76.1' })).toBe(
      '1.76.1'
    )
  })

  it('falls back to GITHUB_REF_NAME on a tag push, where the ref is the tag', () => {
    expect(resolveVersion(undefined, { GITHUB_REF_NAME: 'v1.76.1', RELEASE_TAG: '' })).toBe(
      '1.76.1'
    )
  })

  it('rejects a branch name instead of generating a manifest for it', () => {
    expect(() => resolveVersion(undefined, { GITHUB_REF_NAME: 'main' })).toThrow(
      /GITHUB_REF_NAME is not a version number/
    )
  })

  it('rejects a non-version argument even when a valid RELEASE_TAG is present', () => {
    // Fail closed on the explicit input: silently falling through to the env var would hide a
    // workflow that passes the wrong thing.
    expect(() => resolveVersion('main', { RELEASE_TAG: 'v1.76.1' })).toThrow(
      /the version argument is not a version number/
    )
  })

  it('requires a version when nothing supplies one', () => {
    expect(() => resolveVersion(undefined, {})).toThrow(/version required/)
  })

  it('accepts prerelease and build suffixes', () => {
    expect(resolveVersion('0.2.0-beta.1', {})).toBe('0.2.0-beta.1')
    expect(VERSION_PATTERN.test('1.76.1-rc.2+build.5')).toBe(true)
    expect(VERSION_PATTERN.test('1.76')).toBe(false)
  })
})

// The mirror workflow used to call this CLI with env vars only (DIST_DIR/VERSION/OUTPUT/CDN_BASE_URL/
// S3_PREFIX) and no arguments, which the argument-parsing main() answered with `usage:` and exit 1 —
// so the website mirror step produced no manifest at all. These pin the argument contract it now uses.
describe('resolveManifestOptions', () => {
  it('reads the artifacts dir and version positionally, the mirror URL shape from flags', () => {
    expect(
      resolveManifestOptions(
        [
          'dist-assets',
          '1.76.1',
          '--cdn-base',
          'https://cdn.example.com/',
          '--s3-prefix',
          'ps',
          '--out',
          'version.json'
        ],
        {}
      )
    ).toEqual({
      github: false,
      dir: 'dist-assets',
      versionArg: '1.76.1',
      cdnBase: 'https://cdn.example.com',
      prefix: 'ps',
      out: 'version.json'
    })
  })

  it('does not mistake a flag value for the version', () => {
    // `--out version.json` as the second flag argument: a naive `args.find(!startsWith('--'))` would
    // take `version.json` as the version and then reject it as "not a version number".
    const options = resolveManifestOptions(
      ['artifacts', '--out', 'dist/version.json', '--github'],
      { GITHUB_REF_NAME: 'v1.76.1' }
    )
    expect(options.versionArg).toBeUndefined()
    expect(options.out).toBe('dist/version.json')
    expect(options.github).toBe(true)
  })

  it('falls back to the env vars the workflow exports', () => {
    const options = resolveManifestOptions(['dist-assets', '1.76.1'], {
      CDN_BASE_URL: 'https://cdn.example.com',
      S3_PREFIX: '/ps/',
      OUTPUT: 'version.json'
    })
    expect(options).toMatchObject({
      cdnBase: 'https://cdn.example.com',
      prefix: 'ps',
      out: 'version.json'
    })
  })

  it('defaults the output into the artifacts directory', () => {
    const options = resolveManifestOptions(['dist-assets', '1.76.1', '--github'], {})
    expect(options.out).toBe(join('dist-assets', 'version.json'))
  })

  // Fail closed: a mirrored manifest with no base would carry URLs like `/releases/1.0.0/x.dmg`,
  // which every client reads as "update available" and then fails to download.
  it('refuses a mirrored manifest with no download base', () => {
    expect(() => resolveManifestOptions(['dist-assets', '1.76.1'], {})).toThrow(
      /mirrored manifest needs a download base/
    )
  })

  it('does not demand a base in --github mode, where the URL comes from the tag', () => {
    expect(resolveManifestOptions(['artifacts', '1.76.1', '--github'], {}).github).toBe(true)
  })

  it('reports a flag that is missing its value instead of consuming the next argument', () => {
    expect(() => resolveManifestOptions(['dist-assets', '--github', '--cdn-base'], {})).toThrow(
      /--cdn-base needs a value/
    )
  })

  it('still prints usage when the artifacts directory is missing', () => {
    expect(() => resolveManifestOptions([], {})).toThrow(/usage: generate-version-manifest/)
  })
})

// The publish job runs this CLI and judges it on `$?`, so the exit code is the contract worth pinning
// from a real process. On the v1.76.1 manual dispatch (ref = main, tag = v1.76.1, release_tag=input)
// the job died here with "no installers for version main found in artifacts".
const runCli = (
  args: string[],
  env: Record<string, string>
): { status: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync('node', ['scripts/generate-version-manifest.mjs', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF_NAME: '', RELEASE_TAG: '', ...env }
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

// A release directory as the build matrix leaves it: installers named for 1.76.1 (the version under
// test here) plus the SHA256SUMS.txt the publish job generates before this step.
const RELEASE_1_76_1: FileSpec[] = [
  { name: 'zerolink-purescience-1.76.1-mac-arm64.dmg', content: 'arm', sha: HEX('a') },
  { name: 'zerolink-purescience-1.76.1-mac-x64.dmg', content: 'x64', sha: HEX('b') },
  { name: 'zerolink-purescience-1.76.1-win-x64-setup.exe', content: 'win', sha: HEX('c') }
]

describe('CLI', () => {
  let dir: string | undefined
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it("writes the release tag's manifest on a manual dispatch whose ref is main", () => {
    dir = makeReleaseDir(RELEASE_1_76_1)

    const result = runCli([dir, 'v1.76.1', '--github'], { GITHUB_REF_NAME: 'main' })

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const manifest = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'))
    expect(manifest.version).toBe('1.76.1')
    expect(Object.keys(manifest.downloads).sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64'])
    // URLs point at the tag the Release is published under, not at the branch that was built.
    expect(manifest.downloads['mac-arm64'].url).toBe(
      'https://github.com/naiyixi/PureScience/releases/download/v1.76.1/' +
        'zerolink-purescience-1.76.1-mac-arm64.dmg'
    )
    expect(result.stdout).toContain('version=1.76.1')
  })

  it('resolves the version from RELEASE_TAG when the CLI gets no version argument', () => {
    dir = makeReleaseDir(RELEASE_1_76_1)

    const result = runCli([dir, '--github'], { GITHUB_REF_NAME: 'main', RELEASE_TAG: 'v1.76.1' })

    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')).version).toBe('1.76.1')
  })

  it('fails on a branch ref with a message naming the cause, not "no installers"', () => {
    dir = makeReleaseDir(RELEASE_1_76_1)

    const result = runCli([dir, '--github'], { GITHUB_REF_NAME: 'main' })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/GITHUB_REF_NAME is not a version number: "main"/)
    // The old symptom (a manifest silently built for `main`) must not come back.
    expect(result.stderr).not.toMatch(/no installers/)
  })

  it('still fails closed when the version matches no installer file', () => {
    dir = makeReleaseDir(RELEASE_1_76_1)

    const result = runCli([dir, '1.76.0', '--github'], { GITHUB_REF_NAME: 'v1.76.0' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no installers for version 1.76.0 found in')
  })

  it('keeps working on a tag push, where the ref itself is the tag', () => {
    dir = makeReleaseDir(RELEASE_1_76_1)

    const result = runCli([dir, '--github'], { GITHUB_REF_NAME: 'v1.76.1' })

    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')).version).toBe('1.76.1')
  })

  // The mirror workflow's step, verbatim: positional dir + version, mirror URL shape from flags, and
  // the manifest written where the upload step reads it (not into the artifacts dir).
  it('writes the mirrored manifest with CDN urls to the requested output path', () => {
    const releaseDir = makeReleaseDir([
      ...RELEASE_1_76_1,
      {
        name: 'zerolink-purescience-1.76.1-linux-x86_64.AppImage',
        content: 'appimage',
        sha: HEX('4')
      }
    ])
    dir = releaseDir
    const out = join(releaseDir, 'mirror-version.json')

    const result = runCli(
      [releaseDir, '1.76.1', '--cdn-base', CDN, '--s3-prefix', PREFIX, '--out', out],
      {
        CDN_BASE_URL: '',
        OUTPUT: ''
      }
    )

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const manifest = JSON.parse(readFileSync(out, 'utf8'))
    expect(Object.keys(manifest.downloads).sort()).toEqual([
      'linux-x64-appimage',
      'mac-arm64',
      'mac-x64',
      'win-x64'
    ])
    expect(manifest.downloads['linux-x64-appimage'].url).toBe(
      `${CDN}/${PREFIX}/releases/1.76.1/zerolink-purescience-1.76.1-linux-x86_64.AppImage`
    )
    // The default location stays untouched — the upload step reads the --out path.
    expect(() => readFileSync(join(releaseDir, 'version.json'), 'utf8')).toThrow()
  })

  it('fails with a named message instead of writing a manifest without a download base', () => {
    const releaseDir = makeReleaseDir(RELEASE_1_76_1)
    dir = releaseDir

    const result = runCli([releaseDir, '1.76.1'], { CDN_BASE_URL: '', OUTPUT: '' })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/mirrored manifest needs a download base/)
    expect(() => readFileSync(join(releaseDir, 'version.json'), 'utf8')).toThrow()
  })
})

// The other half of the same gap: the workflow step has to *call* the CLI the way the CLI now takes
// its inputs. Pinning the YAML keeps a future edit from quietly going back to env-only invocation,
// which reads as "the step exists" while producing nothing.
describe('mirror workflow step', () => {
  const stepRun = (): string => {
    const workflow = load(
      readFileSync(join(process.cwd(), '.github', 'workflows', 'mirror-to-website.yml'), 'utf8')
    ) as { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> }
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
    const step = steps.find((candidate) => candidate.name === 'Generate version.json')
    if (!step?.run) throw new Error('the mirror workflow lost its "Generate version.json" step')
    return step.run
  }

  it('passes the artifacts dir, the version and the mirror url flags to the CLI', () => {
    const run = stepRun()
    expect(run).toMatch(/generate-version-manifest\.mjs "\$DIST_DIR" "\$VERSION"/)
    expect(run).toContain('--cdn-base "$CDN_BASE_URL"')
    expect(run).toContain('--s3-prefix "$S3_PREFIX"')
    expect(run).toContain('--out "$OUTPUT"')
  })

  it('does not invoke the CLI with no arguments (the shape that produced nothing)', () => {
    // A bare `node scripts/generate-version-manifest.mjs` line exits 1 with `usage:` — it must not
    // come back as the whole invocation.
    expect(stepRun()).not.toMatch(/generate-version-manifest\.mjs\s*$/m)
  })

  it('refuses to run without a CDN base instead of writing unreachable download urls', () => {
    expect(stepRun()).toMatch(/CDN_BASE_URL is unset/)
  })
})
