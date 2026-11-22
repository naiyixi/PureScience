import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  refreshCertificationDigests,
  refreshVersionManifest
} from './refresh-release-asset-metadata.mjs'

// Every fixture below is a real published file name and the record shape the publish job writes
// (`scripts/ci/release-certification-evidence.mjs aggregate`), so a rename in the pipeline shows up
// here instead of only in a repair that quietly leaves a stale digest behind.

const VERSION = '2.33.1'
const MAC_DMG = `zerolink-purescience-${VERSION}-mac-arm64.dmg`
const MAC_ZIP = `zerolink-purescience-${VERSION}-mac-arm64.zip`
const WIN_EXE = `zerolink-purescience-${VERSION}-win-x64-setup.exe`
const LINUX_DEB = `zerolink-purescience_${VERSION}_amd64.deb`

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const roots: string[] = []
const scratch = (files: Record<string, Buffer>): string => {
  const root = mkdtempSync(join(tmpdir(), 'ps-release-metadata-'))
  roots.push(root)
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(root, name), bytes)
  }
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const sumsText = (entries: [string, Buffer][]): string =>
  `${entries.map(([name, bytes]): string => `${sha256(bytes)}  ${name}`).join('\n')}\n`

type CertificationRecord = {
  schemaVersion: number
  sourceSha: string
  platforms: Array<{
    platform: string
    checks: { electronP0: string; visualRegression: string; packageSmoke: string }
    artifacts: Array<{ name: string; sha256: string }>
    macSignature?: string
    macSignatureEvidence?: { credentialsPresent: boolean; state: string }
  }>
}

const certificationRecord = (artifacts: [string, Buffer][]): CertificationRecord => ({
  schemaVersion: 1,
  sourceSha: 'a'.repeat(40),
  platforms: [
    {
      platform: 'linux-x64',
      checks: {
        electronP0: 'not-applicable',
        visualRegression: 'not-applicable',
        packageSmoke: 'passed'
      },
      artifacts: [{ name: LINUX_DEB, sha256: sha256(Buffer.from('linux-deb')) }]
    },
    {
      platform: 'macos-arm64',
      checks: { electronP0: 'passed', visualRegression: 'passed', packageSmoke: 'passed' },
      artifacts: artifacts.map(([name, bytes]): { name: string; sha256: string } => ({
        name,
        sha256: sha256(bytes)
      })),
      macSignature: 'signed',
      macSignatureEvidence: { credentialsPresent: true, state: 'signed' }
    }
  ]
})

describe('refreshVersionManifest', () => {
  it('rewrites the digest and size of a re-emitted mac installer and leaves the rest alone', () => {
    const signedDmg = Buffer.from('dmg before stapling')
    const stapledDmg = Buffer.from('dmg after stapling — different bytes')
    const exe = Buffer.from('windows installer')
    const root = scratch({})
    writeFileSync(join(root, MAC_DMG), stapledDmg)
    writeFileSync(join(root, WIN_EXE), exe)
    writeFileSync(
      join(root, 'SHA256SUMS.txt'),
      sumsText([
        [MAC_DMG, stapledDmg],
        [WIN_EXE, exe]
      ])
    )
    writeFileSync(
      join(root, 'version.json'),
      `${JSON.stringify(
        {
          version: VERSION,
          notes: 'in-app highlights that must survive the refresh',
          releaseDate: '2026-11-22T00:00:00.000Z',
          downloads: {
            'mac-arm64': {
              url: `https://cdn.example/releases/${VERSION}/${MAC_DMG}`,
              size: signedDmg.length,
              sha256: sha256(signedDmg)
            },
            'win-x64': {
              url: `https://cdn.example/releases/${VERSION}/${WIN_EXE}`,
              size: exe.length,
              sha256: sha256(exe)
            }
          }
        },
        null,
        2
      )}\n`
    )

    const result = refreshVersionManifest({ directory: root, tag: `v${VERSION}` })
    expect(result.changed).toEqual(['mac-arm64'])
    expect(result.added).toEqual([])

    const manifest = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'))
    expect(manifest.downloads['mac-arm64'].sha256).toBe(sha256(stapledDmg))
    expect(manifest.downloads['mac-arm64'].size).toBe(stapledDmg.length)
    // The URL family is the published one, not the GitHub fallback: a repair must not move downloads.
    expect(manifest.downloads['mac-arm64'].url).toBe(
      `https://cdn.example/releases/${VERSION}/${MAC_DMG}`
    )
    expect(manifest.downloads['win-x64'].sha256).toBe(sha256(exe))
    expect(manifest.notes).toBe('in-app highlights that must survive the refresh')
    expect(manifest.releaseDate).toBe('2026-11-22T00:00:00.000Z')
  })

  it('creates the manifest from the directory when the release never had one', () => {
    const dmg = Buffer.from('mac dmg')
    const root = scratch({})
    writeFileSync(join(root, MAC_DMG), dmg)
    writeFileSync(join(root, WIN_EXE), Buffer.from('win'))
    writeFileSync(
      join(root, 'SHA256SUMS.txt'),
      sumsText([
        [MAC_DMG, dmg],
        [WIN_EXE, Buffer.from('win')]
      ])
    )

    const result = refreshVersionManifest({ directory: root, tag: `v${VERSION}` })
    expect(result.total).toBe(2)
    const manifest = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'))
    expect(manifest.downloads['mac-arm64'].url).toBe(
      `https://github.com/naiyixi/PureScience/releases/download/v${VERSION}/${MAC_DMG}`
    )
    expect(manifest.downloads['mac-arm64'].sha256).toBe(sha256(dmg))
  })

  it('refuses an installer that has no checksum instead of carrying a stale digest', () => {
    const root = scratch({})
    writeFileSync(join(root, MAC_DMG), Buffer.from('stapled'))
    // A checksum list that is present but does not cover the installer about to be rewritten.
    writeFileSync(
      join(root, 'SHA256SUMS.txt'),
      sumsText([[WIN_EXE, Buffer.from('windows installer')]])
    )
    expect(() => refreshVersionManifest({ directory: root, tag: `v${VERSION}` })).toThrow(
      /installer\(s\) present without a SHA256SUMS.txt entry: .*mac-arm64\.dmg/
    )
  })

  it('refuses to keep a digest for an installer the release no longer carries', () => {
    const dmg = Buffer.from('mac')
    const root = scratch({})
    writeFileSync(join(root, MAC_DMG), dmg)
    writeFileSync(join(root, 'SHA256SUMS.txt'), sumsText([[MAC_DMG, dmg]]))
    writeFileSync(
      join(root, 'version.json'),
      `${JSON.stringify(
        {
          version: VERSION,
          notes: '',
          releaseDate: '2026-11-22T00:00:00.000Z',
          downloads: {
            'mac-arm64': {
              url: `https://example/${MAC_DMG}`,
              size: dmg.length,
              sha256: sha256(dmg)
            },
            'mac-x64': {
              url: `https://example/zerolink-purescience-${VERSION}-mac-x64.dmg`,
              size: 1,
              sha256: 'b'.repeat(64)
            }
          }
        },
        null,
        2
      )}\n`
    )
    expect(() => refreshVersionManifest({ directory: root, tag: `v${VERSION}` })).toThrow(
      /names installer\(s\) this release does not carry: mac-x64:/
    )
  })

  it('refuses to rewrite a manifest that describes another version', () => {
    const dmg = Buffer.from('mac')
    const root = scratch({})
    writeFileSync(join(root, MAC_DMG), dmg)
    writeFileSync(join(root, 'SHA256SUMS.txt'), sumsText([[MAC_DMG, dmg]]))
    writeFileSync(
      join(root, 'version.json'),
      `${JSON.stringify({ version: '2.33.0', notes: '', releaseDate: '', downloads: {} })}\n`
    )
    expect(() => refreshVersionManifest({ directory: root, tag: `v${VERSION}` })).toThrow(
      /describes version 2\.33\.0, not 2\.33\.1/
    )
  })
})

describe('refreshCertificationDigests', () => {
  it('rewrites the mac artifact digests, records why, and keeps signing evidence verbatim', () => {
    const signedDmg = Buffer.from('signed dmg')
    const signedZip = Buffer.from('signed zip')
    const stapledDmg = Buffer.from('stapled dmg')
    const stapledZip = Buffer.from('stapled zip')
    const root = scratch({})
    writeFileSync(join(root, MAC_DMG), stapledDmg)
    writeFileSync(join(root, MAC_ZIP), stapledZip)
    writeFileSync(join(root, LINUX_DEB), Buffer.from('linux-deb'))
    writeFileSync(
      join(root, 'RELEASE-CERTIFICATION.json'),
      `${JSON.stringify(
        certificationRecord([
          [MAC_DMG, signedDmg],
          [MAC_ZIP, signedZip]
        ]),
        null,
        2
      )}\n`
    )

    const result = refreshCertificationDigests({ directory: root })
    expect(result.changed.sort()).toEqual(
      [`macos-arm64:${MAC_DMG}`, `macos-arm64:${MAC_ZIP}`].sort()
    )

    const record = JSON.parse(readFileSync(join(root, 'RELEASE-CERTIFICATION.json'), 'utf8'))
    const mac = record.platforms.find((platform) => platform.platform === 'macos-arm64')
    expect(mac.artifacts.find((artifact) => artifact.name === MAC_DMG).sha256).toBe(
      sha256(stapledDmg)
    )
    expect(mac.artifacts.find((artifact) => artifact.name === MAC_ZIP).sha256).toBe(
      sha256(stapledZip)
    )
    // Measured facts are carried, not re-derived: the build measured them on the bytes it shipped.
    expect(mac.macSignature).toBe('signed')
    expect(mac.checks.electronP0).toBe('passed')
    expect(record.metadataRefreshed.reason).toBe('stapled-assets-replaced-after-publication')
    expect(record.metadataRefreshed.digests).toHaveLength(2)
    // A platform a mac repair never touched keeps its own digest.
    const linux = record.platforms.find((platform) => platform.platform === 'linux-x64')
    expect(linux.artifacts[0].sha256).toBe(sha256(Buffer.from('linux-deb')))
  })

  it('leaves the record byte-identical when the digests already describe the directory', () => {
    const dmg = Buffer.from('already stapled')
    const root = scratch({})
    writeFileSync(join(root, MAC_DMG), dmg)
    writeFileSync(join(root, LINUX_DEB), Buffer.from('linux-deb'))
    const body = `${JSON.stringify(certificationRecord([[MAC_DMG, dmg]]), null, 2)}\n`
    writeFileSync(join(root, 'RELEASE-CERTIFICATION.json'), body)

    const result = refreshCertificationDigests({ directory: root })
    expect(result.changed).toEqual([])
    expect(readFileSync(join(root, 'RELEASE-CERTIFICATION.json'), 'utf8')).toBe(body)
  })

  it('refuses to keep a digest for an artifact the directory does not carry', () => {
    const dmg = Buffer.from('mac')
    const root = scratch({})
    writeFileSync(join(root, LINUX_DEB), Buffer.from('linux-deb'))
    writeFileSync(
      join(root, 'RELEASE-CERTIFICATION.json'),
      `${JSON.stringify(
        certificationRecord([
          [MAC_DMG, dmg],
          [MAC_ZIP, Buffer.from('zip')]
        ]),
        null,
        2
      )}\n`
    )
    expect(() => refreshCertificationDigests({ directory: root })).toThrow(
      /absent from .*mac-arm64\.dmg/
    )
  })

  it('refuses a record with no macos-* platform', () => {
    const root = scratch({})
    writeFileSync(join(root, LINUX_DEB), Buffer.from('linux-deb'))
    const record = certificationRecord([])
    record.platforms = record.platforms.filter((platform) => platform.platform !== 'macos-arm64')
    writeFileSync(join(root, 'RELEASE-CERTIFICATION.json'), `${JSON.stringify(record, null, 2)}\n`)
    expect(() => refreshCertificationDigests({ directory: root })).toThrow(
      /carries no macos-\* platform/
    )
  })
})

describe('CLI', () => {
  it('rewrites both files from a release directory and prints what it refreshed', () => {
    const signedDmg = Buffer.from('before')
    const stapledDmg = Buffer.from('after stapling')
    const root = scratch({})
    writeFileSync(join(root, MAC_DMG), stapledDmg)
    writeFileSync(join(root, 'SHA256SUMS.txt'), sumsText([[MAC_DMG, stapledDmg]]))
    writeFileSync(
      join(root, 'version.json'),
      `${JSON.stringify(
        {
          version: VERSION,
          notes: 'kept',
          releaseDate: '2026-11-22T00:00:00.000Z',
          downloads: {
            'mac-arm64': { url: '', size: signedDmg.length, sha256: sha256(signedDmg) }
          }
        },
        null,
        2
      )}\n`
    )
    writeFileSync(
      join(root, 'RELEASE-CERTIFICATION.json'),
      `${JSON.stringify(certificationRecord([[MAC_DMG, signedDmg]]), null, 2)}\n`
    )

    const stdout = execFileSync(
      process.execPath,
      [join(import.meta.dirname, 'refresh-release-asset-metadata.mjs'), root, `v${VERSION}`],
      { encoding: 'utf8' }
    )
    expect(stdout).toContain('==> version.json: version=2.33.1 downloads=1 refreshed=[mac-arm64]')
    expect(stdout).toContain('==> RELEASE-CERTIFICATION.json: platforms=macos-arm64 refreshed=1')
    expect(existsSync(join(root, 'version.json'))).toBe(true)
  })

  it('exits non-zero with the named failure when the checksum list is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ps-release-metadata-cli-'))
    roots.push(root)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, MAC_DMG), Buffer.from('dmg'))
    let failure
    try {
      execFileSync(
        process.execPath,
        [join(import.meta.dirname, 'refresh-release-asset-metadata.mjs'), root, `v${VERSION}`],
        { encoding: 'utf8', stdio: 'pipe' }
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeDefined()
    expect(failure.status).toBe(1)
    expect(String(failure.stderr)).toContain('SHA256SUMS.txt is not in')
  })
})
