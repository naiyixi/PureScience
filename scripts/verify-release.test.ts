import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MIN_BODY_BYTES,
  evaluateRelease,
  parseGatekeeperAssessment,
  parseSha256Sums,
  planRequiredAssets,
  readCertification
} from './verify-release.mjs'

// The asset names and record shape below are the ones v2.26.0 actually shipped (read from
// `gh release view` and the downloaded RELEASE-CERTIFICATION.json), so a rename in the pipeline shows
// up here as a named missing family rather than as a silently greener run.
const VERSION = '2.26.0'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

const primary = [
  { name: `zerolink-purescience-${VERSION}-mac-arm64.dmg`, sha256: SHA_A },
  { name: `zerolink-purescience-${VERSION}-mac-arm64.zip`, sha256: SHA_B },
  { name: `zerolink-purescience-${VERSION}-mac-x64.dmg`, sha256: SHA_A },
  { name: `zerolink-purescience-${VERSION}-mac-x64.zip`, sha256: SHA_B },
  { name: `zerolink-purescience-${VERSION}-win-x64.zip`, sha256: SHA_A },
  { name: `zerolink-purescience-${VERSION}-win-x64-setup.exe`, sha256: SHA_B },
  { name: `zerolink-purescience-${VERSION}-linux-x86_64.AppImage`, sha256: SHA_A },
  { name: `zerolink-purescience_${VERSION}_amd64.deb`, sha256: SHA_B }
]

const assetNamesFor = (): string[] => [
  'RELEASE-CERTIFICATION.json',
  'SHA256SUMS.txt',
  'arm64-mac.yml',
  'latest-linux.yml',
  'latest-mac.yml',
  'latest.yml',
  'version.json',
  'x64-mac.yml',
  ...primary.map((entry) => entry.name),
  `zerolink-purescience-${VERSION}-mac-arm64.dmg.blockmap`,
  `zerolink-purescience-${VERSION}-mac-arm64.zip.blockmap`,
  `zerolink-purescience-${VERSION}-mac-x64.dmg.blockmap`,
  `zerolink-purescience-${VERSION}-mac-x64.zip.blockmap`,
  `zerolink-purescience-${VERSION}-win-x64-setup.exe.blockmap`
]

const sumsText = (entries = primary): string =>
  entries.map((entry) => `${entry.sha256}  ${entry.name}`).join('\n')

type FixtureArtifact = { name: string; sha256: string }
type FixturePlatform = {
  platform: string
  macSignature?: string
  macSignatureEvidence?: { credentialsPresent?: boolean }
  artifacts: FixtureArtifact[]
}
type FixtureCertification = {
  schemaVersion: number
  sourceSha: string
  platforms?: FixturePlatform[]
}
type FixtureRelease = {
  name: string
  tagName: string
  isDraft: boolean
  isPrerelease: boolean
  publishedAt: string
  body: string
  assets: { name: string }[]
}

const certificationFor = (overrides: Partial<FixtureCertification> = {}): FixtureCertification => ({
  schemaVersion: 1,
  sourceSha: 'deadbeef',
  platforms: [
    {
      platform: 'macos-arm64',
      macSignature: 'unsigned',
      macSignatureEvidence: { credentialsPresent: false },
      artifacts: primary.slice(0, 2)
    },
    {
      platform: 'macos-x64',
      macSignature: 'unsigned',
      macSignatureEvidence: { credentialsPresent: false },
      artifacts: primary.slice(2, 4)
    },
    { platform: 'linux-x64', artifacts: primary.slice(6, 8) },
    { platform: 'windows-x64', artifacts: primary.slice(4, 6) }
  ],
  ...overrides
})

const body = 'x'.repeat(DEFAULT_MIN_BODY_BYTES)

const releaseFor = (overrides: Partial<FixtureRelease> = {}): FixtureRelease => ({
  name: 'PureScience v2.26.0',
  tagName: 'v2.26.0',
  isDraft: false,
  isPrerelease: false,
  publishedAt: '2026-11-04T19:15:31Z',
  body,
  assets: assetNamesFor().map((name) => ({ name })),
  ...overrides
})

const verdict = (overrides: Record<string, unknown> = {}): ReturnType<typeof evaluateRelease> =>
  evaluateRelease({
    tag: 'v2.26.0',
    release: releaseFor(),
    assetNames: assetNamesFor(),
    certification: certificationFor(),
    sha256SumsText: sumsText(),
    headSha: 'deadbeef',
    ...overrides
  })

const failing = (result: { checks: { name: string; ok: boolean }[] }): string[] =>
  result.checks.filter((c) => !c.ok).map((c) => c.name)

describe('planRequiredAssets', () => {
  it('names every family the pipeline promises, substituting the version into the deb name', () => {
    const planned = planRequiredAssets('9.9.9')
    const suffixes = planned.map((entry: { suffix: string }) => entry.suffix)
    expect(suffixes).toContain('_9.9.9_amd64.deb')
    expect(suffixes).toContain('-mac-arm64.zip.blockmap')
    expect(suffixes).toContain('RELEASE-CERTIFICATION.json')
    // 21 families: 8 mac, 2 linux, 3 windows, 8 metadata. A change here is a pipeline change.
    expect(planned).toHaveLength(21)
  })
})

describe('parseSha256Sums', () => {
  it('reads coreutils-style lines and ignores anything else instead of guessing', () => {
    const parsed = parseSha256Sums(
      `${SHA_A}  one.dmg\nnot a line\n${SHA_B} *two.zip\n${SHA_A} three.zip\n`
    )
    expect([...parsed.keys()]).toEqual(['one.dmg', 'two.zip'])
    expect(parsed.get('one.dmg')).toBe(SHA_A)
  })

  it('parses nothing out of text that carries no digests', () => {
    expect(parseSha256Sums('garbage\n').size).toBe(0)
    expect(parseSha256Sums(undefined).size).toBe(0)
  })
})

describe('readCertification', () => {
  it('flattens per-platform artifacts and keeps each platform’s own signature reading', () => {
    const record = readCertification(certificationFor())
    expect(record.sourceSha).toBe('deadbeef')
    expect(record.artifacts.size).toBe(8)
    expect(record.macSigning).toEqual([
      { platform: 'macos-arm64', macSignature: 'unsigned', credentialsPresent: false },
      { platform: 'macos-x64', macSignature: 'unsigned', credentialsPresent: false }
    ])
  })

  it('tolerates a record with no platforms array', () => {
    expect(readCertification(undefined).artifacts.size).toBe(0)
    expect(readCertification({}).sourceSha).toBe('')
  })
})

describe('evaluateRelease', () => {
  it('accepts a published page whose assets, digests and record all line up', () => {
    const result = verdict()
    expect(result.ok).toBe(true)
    expect(failing(result)).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('rejects a page that does not exist', () => {
    const result = verdict({ release: undefined })
    expect(result.ok).toBe(false)
    expect(failing(result)).toContain('page-exists')
  })

  it('rejects a draft page', () => {
    expect(failing(verdict({ release: releaseFor({ isDraft: true }) }))).toContain('page-not-draft')
  })

  it('rejects a prerelease unless the caller allowed it, and then says so', () => {
    expect(failing(verdict({ release: releaseFor({ isPrerelease: true }) }))).toContain(
      'page-not-prerelease'
    )
    const allowed = verdict({ release: releaseFor({ isPrerelease: true }), allowPrerelease: true })
    expect(allowed.ok).toBe(true)
    expect(
      allowed.checks.find((c: { name: string }) => c.name === 'page-not-prerelease').detail
    ).toContain('allowed by flag')
  })

  it('names each missing asset family instead of counting them', () => {
    const missingArm64Zip = assetNamesFor().filter((name) => !name.endsWith('-mac-arm64.zip'))
    const result = verdict({ assetNames: missingArm64Zip })
    expect(result.ok).toBe(false)
    const assets = result.checks.find((c: { name: string }) => c.name === 'assets-complete')
    expect(assets.ok).toBe(false)
    expect(assets.detail).toContain('mac-arm64-zip')
    expect(assets.detail).toContain('-mac-arm64.zip')
  })

  it('does not mistake a differently-cased certification asset for the real one', () => {
    const result = verdict({ assetNames: assetNamesFor().map((name) => name.toLowerCase()) })
    expect(result.ok).toBe(false)
    expect(failing(result)).toContain('assets-complete')
  })

  it('rejects a body shorter than the floor and one that still carries generator noise', () => {
    expect(failing(verdict({ release: releaseFor({ body: 'too short' }) }))).toContain(
      'body-length'
    )
    expect(
      failing(
        verdict({ release: releaseFor({ body: `${body}\nrelease-notes: raw generator line` }) })
      )
    ).toContain('body-no-generator-noise')
  })

  it('compares the record’s sourceSha against the commit the tag points at', () => {
    const mismatch = verdict({ headSha: 'otherossha' })
    expect(mismatch.ok).toBe(false)
    const sha = mismatch.checks.find((c: { name: string }) => c.name === 'source-sha-matches-tag')
    expect(sha.ok).toBe(false)
    expect(sha.detail).toContain('otherossha')
  })

  it('refuses to read an unreadable record as a match', () => {
    const result = verdict({ certification: undefined, certificationSkipReason: 'download failed' })
    expect(result.ok).toBe(false)
    expect(failing(result)).toEqual(
      expect.arrayContaining([
        'certification-read',
        'source-sha-matches-tag',
        'record-artifacts-on-page'
      ])
    )
  })

  it('fails when a recorded artifact is absent from the page', () => {
    const withoutDeb = assetNamesFor().filter((name) => !name.endsWith('.deb'))
    const result = verdict({ assetNames: withoutDeb })
    expect(result.ok).toBe(false)
    expect(failing(result)).toContain('record-artifacts-on-page')
  })

  it('fails when the two digest sources disagree, naming the file', () => {
    const tampered = primary.map((entry, index) =>
      index === 0 ? { ...entry, sha256: 'c'.repeat(64) } : entry
    )
    const result = verdict({ sha256SumsText: sumsText(tampered) })
    expect(result.ok).toBe(false)
    const digest = result.checks.find((c: { name: string }) => c.name === 'sha256sums-match-record')
    expect(digest.ok).toBe(false)
    expect(digest.detail).toContain(primary[0]!.name)
  })

  it('fails when nothing was compared, rather than reading an empty parse as agreement', () => {
    const result = verdict({ sha256SumsText: 'no digests here\n' })
    expect(result.ok).toBe(false)
    const digest = result.checks.find((c: { name: string }) => c.name === 'sha256sums-match-record')
    expect(digest.ok).toBe(false)
    expect(digest.detail).toContain('parsed 0 sums line')
  })

  it('warns (does not fail) when the sums file covers fewer artifacts than the record', () => {
    const partial = primary.slice(0, 4)
    const result = verdict({ sha256SumsText: sumsText(partial) })
    expect(result.ok).toBe(true)
    expect(failing(result)).toContain('sha256sums-covers-record')
    expect(result.warnings).toHaveLength(1)
  })

  it('reports the signing state verbatim from the record', () => {
    const detail = verdict().checks.find(
      (c: { name: string }) => c.name === 'mac-signing-observed'
    ).detail
    expect(detail).toBe(
      'macos-arm64=unsigned (credentialsPresent=false); macos-x64=unsigned (credentialsPresent=false)'
    )
  })

  it('accepts an unsigned release by default but rejects it when signing was required', () => {
    expect(verdict().ok).toBe(true)

    const signed = certificationFor()
    signed.platforms![0]!.macSignature = 'developer-id'
    signed.platforms![1]!.macSignature = 'developer-id'
    expect(verdict({ certification: signed, requireSigned: true }).ok).toBe(true)

    const halfSigned = certificationFor()
    halfSigned.platforms![0]!.macSignature = 'developer-id'
    const rejected = verdict({ certification: halfSigned, requireSigned: true })
    expect(rejected.ok).toBe(false)
    expect(failing(rejected)).toContain('mac-signing-observed')
  })

  it('refuses to call a record without any signature reading signed', () => {
    const noSignature = certificationFor({
      platforms: [{ platform: 'linux-x64', artifacts: primary.slice(6, 8) }]
    })
    expect(verdict({ certification: noSignature }).ok).toBe(true)
    expect(verdict({ certification: noSignature, requireSigned: true }).ok).toBe(false)
  })
})

// The two outputs below are what the tools actually print on this machine (accepted form read from a
// notarized dmg, rejected form from an ad-hoc one); the parser must not be tuned to a cleaner shape
// than the real one.
const SPCTL_ACCEPTED = [
  '/tmp/x.dmg: accepted',
  'source=Notarized Developer ID',
  'origin=Developer ID Application: Zerolink (ABCDE12345)'
].join('\n')
const SPCTL_REJECTED = ['/tmp/x.dmg: rejected', 'source=no usable signature'].join('\n')

describe('parseGatekeeperAssessment', () => {
  it('reads an accepted, notarized image with a stapled ticket', () => {
    expect(
      parseGatekeeperAssessment({
        spctlStatus: 0,
        spctlStdout: '',
        spctlStderr: SPCTL_ACCEPTED,
        staplerStatus: 0,
        staplerStdout: 'Processing: /tmp/x.dmg\nThe validate action worked!\n',
        staplerStderr: ''
      })
    ).toEqual({ verdict: 'accepted', source: 'Notarized Developer ID', stapled: 'valid' })
  })

  it('reads a rejected image and an unstapled ticket as two separate findings', () => {
    expect(
      parseGatekeeperAssessment({
        spctlStatus: 3,
        spctlStdout: '',
        spctlStderr: SPCTL_REJECTED,
        staplerStatus: 65,
        staplerStdout: 'Processing: /tmp/x.dmg\nDoes not have a ticket stapled to it\n',
        staplerStderr: ''
      })
    ).toEqual({ verdict: 'rejected', source: 'no usable signature', stapled: 'missing' })
  })

  it('reads empty output as unreadable rather than as a pass', () => {
    expect(parseGatekeeperAssessment({ spctlStatus: 1, staplerStatus: 1 })).toEqual({
      verdict: 'unreadable',
      source: null,
      stapled: 'unreadable'
    })
  })

  it('does not read a tool that never ran as an answer', () => {
    // spawnSync reports status null for a binary that is not installed; the text of a missing tool
    // cannot be accepted just because it happens to contain the word "accepted" somewhere.
    expect(
      parseGatekeeperAssessment({
        spctlStatus: null,
        spctlStderr: SPCTL_ACCEPTED,
        staplerStatus: null,
        staplerStdout: 'The validate action worked!'
      })
    ).toEqual({ verdict: 'unreadable', source: 'Notarized Developer ID', stapled: 'unreadable' })
  })

  it('does not turn a failed ticket lookup into "no ticket"', () => {
    // A network/tooling failure is a reading we do not have, not evidence the ticket is absent.
    expect(
      parseGatekeeperAssessment({
        spctlStatus: 0,
        spctlStderr: SPCTL_ACCEPTED,
        staplerStatus: 1,
        staplerStdout: 'Processing: /tmp/x.dmg\nCloudKit query failed.\nError: NSURLErrorDomain',
        staplerStderr: ''
      }).stapled
    ).toBe('unreadable')
  })

  it('does not accept a zero exit without the tool’s own confirmation line', () => {
    expect(
      parseGatekeeperAssessment({ spctlStatus: 0, staplerStatus: 0, staplerStdout: '' }).stapled
    ).toBe('unreadable')
  })
})

describe('evaluateRelease with a Gatekeeper assessment', () => {
  const dmgs = primary
    .filter((entry) => entry.name.includes('-mac-') && entry.name.endsWith('.dmg'))
    .map((entry) => entry.name)

  const assessed = (
    verdictName: 'accepted' | 'rejected' | 'unreadable',
    source: string | null,
    stapled: 'valid' | 'missing' | 'unreadable'
  ): { asset: string; verdict: string; source: string | null; stapled: string }[] =>
    dmgs.map((asset) => ({ asset, verdict: verdictName, source, stapled }))

  const gatekeeperChecks = (result: { checks: { name: string; ok: boolean }[] }): string[] =>
    result.checks.filter((c) => c.name.startsWith('gatekeeper:')).map((c) => c.name)

  it('adds one reading per mac dmg, and stays silent when not asked', () => {
    const notAsked = verdict()
    expect(gatekeeperChecks(notAsked)).toHaveLength(0)
    expect(notAsked.ok).toBe(true)
    expect(notAsked.checks.some((c: { name: string }) => c.name === 'gatekeeper-assessed')).toBe(
      true
    )

    const asked = verdict({
      installerAssessments: assessed('accepted', 'Notarized Developer ID', 'valid')
    })
    expect(gatekeeperChecks(asked)).toEqual(dmgs.map((asset) => `gatekeeper:${asset}`))
    expect(asked.ok).toBe(true)
  })

  it('fails a notarized-required release whose installers Gatekeeper rejects', () => {
    const result = verdict({
      installerAssessments: assessed('rejected', 'no usable signature', 'missing'),
      requireNotarized: true
    })
    expect(result.ok).toBe(false)
    expect(failing(result)).toContain(`gatekeeper:${dmgs[0]}`)
    expect(failing(result)).toContain(`stapled:${dmgs[0]}`)
  })

  it('accepts a signed-but-unstapled image only when notarization was required', () => {
    // Developer ID without a stapled ticket is the exact state a "signed" release used to hide.
    const unstapled = assessed('accepted', 'Developer ID', 'missing')
    expect(verdict({ installerAssessments: unstapled }).ok).toBe(true)
    const strict = verdict({ installerAssessments: unstapled, requireNotarized: true })
    expect(strict.ok).toBe(false)
    expect(failing(strict)[0]).toMatch(/^gatekeeper:/)
  })

  it('refuses to pass a notarized-required release that was never assessed', () => {
    const neverAsked = verdict({ requireNotarized: true })
    expect(neverAsked.ok).toBe(false)
    expect(failing(neverAsked)).toContain('gatekeeper-assessed')

    const nothingOnPage = verdict({ installerAssessments: [], requireNotarized: true })
    expect(nothingOnPage.ok).toBe(false)
    expect(
      nothingOnPage.checks.find((c: { name: string }) => c.name === 'gatekeeper-assessed')
    ).toMatchObject({ ok: false })
  })

  it('names the host that cannot assess instead of reporting a pass', () => {
    const result = verdict({
      installerAssessments: [],
      gatekeeperSkipReason: 'this host is linux; spctl and stapler validate only run on macOS',
      requireNotarized: true
    })
    expect(result.ok).toBe(false)
    const check = result.checks.find((c: { name: string }) => c.name === 'gatekeeper-assessed')
    expect(check?.detail).toContain('only run on macOS')
  })
})
