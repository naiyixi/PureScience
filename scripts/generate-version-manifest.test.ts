import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildManifest,
  extractHighlights,
  manifestNotes,
  NOTES_FALLBACK,
  parseSha256Sums,
  resolveVersion,
  VERSION_PATTERN
} from './generate-version-manifest.mjs'

const VERSION = '0.1.2'
const CDN = 'https://cdn.example.com'
const PREFIX = 'purescience'

// The full set of installer filenames a complete release produces (matches electron-builder.yml
// artifactName templates with the zerolink- prefix).
const INSTALLERS = {
  'mac-arm64': `zerolink-purescience-${VERSION}-mac-arm64.dmg`,
  'mac-x64': `zerolink-purescience-${VERSION}-mac-x64.dmg`,
  'win-x64': `zerolink-purescience-${VERSION}-win-x64-setup.exe`,
  'linux-x64-appimage': `zerolink-purescience-${VERSION}-linux-x64.AppImage`,
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
    const files = Object.keys(INSTALLERS).map((key, i) => entry(key, i + 1))
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
    expect(manifest.downloads['linux-x64-deb'].sha256).toBe(deb.sha)
    expect(manifest.downloads['linux-x64-deb'].size).toBe(deb.content.length)
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
})
