import { describe, expect, it } from 'vitest'

import {
  MAC_SIGNING_DISCLOSURE_MARKER,
  MAC_TEAM_ID_ENV,
  ensureDisclosureInBody,
  evaluateMacSignatureGate,
  expectedMacTeamId,
  macSignatureEvidence,
  macSigningDisclosure,
  macSigningDisclosureFromRecord,
  parseCodesignDescription,
  readMacBundleSignature,
  readingIsObserved,
  unobservedDetail
} from './mac-signing-status.mjs'

// A team id that belongs to nobody. The gate must take the expectation as configuration (the same
// PURESCIENCE_MAC_TEAM_ID the app reads), never as a constant in this repository — a constant would
// certify a signature this project does not own.
const TEST_TEAM_ID = 'TESTTEAM01'
const OTHER_TEAM_ID = 'OTHERTEAM1'

// A real Developer ID description, as `codesign -d --verbose=4` prints it.
const DEVELOPER_ID_DESCRIPTION = [
  'Executable=/tmp/PureScience.app/Contents/MacOS/PureScience',
  'Identifier=com.zerolink.purescience',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=1+3 location=embedded',
  `TeamIdentifier=${TEST_TEAM_ID}`,
  'Authority=Developer ID Application: ZEROLINK'
].join('\n')

// The ad-hoc signature the shipping pipeline leaves when no certificate exists.
const AD_HOC_DESCRIPTION = [
  'Executable=/tmp/PureScience.app/Contents/MacOS/PureScience',
  'Identifier=com.zerolink.purescience',
  'Signature=adhoc',
  'TeamIdentifier=not set'
].join('\n')

const signedReading = {
  schemaVersion: 1,
  source: 'shipped-zip',
  artifact: 'zerolink-purescience-1.0.0-mac-arm64.zip',
  readable: true,
  identifier: 'com.zerolink.purescience',
  teamIdentifier: TEST_TEAM_ID,
  signed: true
}

const unsignedReading = {
  schemaVersion: 1,
  source: 'shipped-zip',
  artifact: 'zerolink-purescience-1.0.0-mac-arm64.zip',
  readable: true,
  identifier: 'com.zerolink.purescience',
  teamIdentifier: 'not set',
  signed: false
}

describe('mac signing status gate', () => {
  it('reads the expected team from configuration, never from a constant in the repository', () => {
    expect(expectedMacTeamId({ [MAC_TEAM_ID_ENV]: ' TEAM123456 ' })).toBe('TEAM123456')
    expect(expectedMacTeamId({})).toBe('')
    expect(expectedMacTeamId({ [MAC_TEAM_ID_ENV]: '   ' })).toBe('')
  })

  it('passes signed assets when the signing credentials are configured', () => {
    const decision = evaluateMacSignatureGate({
      credentialsPresent: true,
      reading: signedReading,
      expectedTeamId: TEST_TEAM_ID
    })

    expect(decision).toMatchObject({ macSignature: 'signed', ok: true })
    expect(decision.reason).toContain(TEST_TEAM_ID)
  })

  it('fails unsigned assets when the signing credentials are configured (fail-closed)', () => {
    const decision = evaluateMacSignatureGate({
      credentialsPresent: true,
      reading: unsignedReading,
      expectedTeamId: TEST_TEAM_ID
    })

    expect(decision).toMatchObject({ macSignature: 'unsigned', ok: false })
    expect(decision.reason).toContain('NOT signed by the expected team')
    expect(decision.reason).toContain('not set')
    expect(decision.reason).toContain(TEST_TEAM_ID)
  })

  // A credentialed run whose team was never provisioned has nothing to compare against. It must stop
  // and name the variable, not fall back to "any Developer ID" (that reading is what let an ad-hoc
  // build look certified in the first place).
  it('fails a credentialed run when no expected team is provisioned, naming the variable', () => {
    const decision = evaluateMacSignatureGate({
      credentialsPresent: true,
      reading: signedReading,
      expectedTeamId: ''
    })

    expect(decision).toMatchObject({ macSignature: 'unsigned', ok: false })
    expect(decision.reason).toContain(MAC_TEAM_ID_ENV)
    expect(decision.reason).toContain('unprovisioned is not a pass')
  })

  it('fails a credentialed run signed by another team, naming both ids', () => {
    const decision = evaluateMacSignatureGate({
      credentialsPresent: true,
      reading: { ...signedReading, teamIdentifier: OTHER_TEAM_ID },
      expectedTeamId: TEST_TEAM_ID
    })

    expect(decision).toMatchObject({ macSignature: 'unsigned', ok: false })
    expect(decision.reason).toContain(OTHER_TEAM_ID)
    expect(decision.reason).toContain(TEST_TEAM_ID)
  })

  // The reading is written by the smoke step, but the verdict is not: a file that claims signed: true
  // for a team we do not own must not become a pass.
  it('does not let a reading claim a signature for a team the project does not own', () => {
    const decision = evaluateMacSignatureGate({
      credentialsPresent: false,
      reading: { ...signedReading, teamIdentifier: OTHER_TEAM_ID },
      expectedTeamId: TEST_TEAM_ID
    })

    expect(decision).toMatchObject({ macSignature: 'unsigned', ok: true })
  })

  it('passes but labels an unsigned asset when no credentials are configured', () => {
    const decision = evaluateMacSignatureGate({
      credentialsPresent: false,
      reading: unsignedReading,
      expectedTeamId: TEST_TEAM_ID
    })

    expect(decision).toMatchObject({ macSignature: 'unsigned', ok: true })
    expect(decision.reason).toContain('recorded as unsigned')
  })

  it('never treats a missing reading without credentials as a pass', () => {
    for (const reading of [undefined, null, {}, { readable: false, signed: false }]) {
      const decision = evaluateMacSignatureGate({ credentialsPresent: false, reading })

      expect(decision.ok).toBe(false)
      expect(decision.macSignature).toBe('unproven')
      expect(decision.reason).toContain('unobserved')
    }
  })

  it('fails a credentialed run whose reading was never taken', () => {
    const decision = evaluateMacSignatureGate({ credentialsPresent: true, reading: undefined })

    expect(decision).toMatchObject({ macSignature: 'unproven', ok: false })
    expect(decision.reason).toContain('unobserved is not a pass')
  })

  it('records the readings that produced the verdict', () => {
    expect(
      macSignatureEvidence({
        credentialsPresent: false,
        reading: unsignedReading,
        expectedTeamId: TEST_TEAM_ID
      })
    ).toEqual({
      macSignature: 'unsigned',
      macSignatureEvidence: {
        credentialsPresent: false,
        teamIdExpected: TEST_TEAM_ID,
        teamIdExpectation: 'configured',
        identifier: 'com.zerolink.purescience',
        teamIdentifier: 'not set',
        readingSource: 'shipped-zip'
      }
    })

    expect(
      macSignatureEvidence({
        credentialsPresent: true,
        reading: undefined,
        expectedTeamId: TEST_TEAM_ID
      })
    ).toEqual({
      macSignature: 'unproven',
      macSignatureEvidence: {
        credentialsPresent: true,
        teamIdExpected: TEST_TEAM_ID,
        teamIdExpectation: 'configured',
        identifier: null,
        teamIdentifier: null,
        readingSource: 'not-read'
      }
    })

    // Unprovisioned names itself in the record instead of leaving an empty field behind.
    expect(
      macSignatureEvidence({
        credentialsPresent: false,
        reading: unsignedReading,
        expectedTeamId: ''
      }).macSignatureEvidence
    ).toMatchObject({ teamIdExpected: 'not-configured', teamIdExpectation: 'not-configured' })
  })

  // "Never read" has three causes with three different next steps: the step did not run, it ran and failed
  // before reading, or it wrote something unusable. One sentence for all three leaves a red job with no next
  // step — and the smoke step has `continue-on-error`, so the gate's own verdict is where this has to land.
  it('names which cause left the signature unread instead of one sentence for three causes', () => {
    const missing = evaluateMacSignatureGate({ credentialsPresent: true, reading: undefined })
    const unreadable = evaluateMacSignatureGate({
      credentialsPresent: true,
      reading: {
        schemaVersion: 1,
        source: 'smoke-failure',
        readable: false,
        signed: false,
        reason: 'SMOKE_TIMEOUT: Timed out waiting for the packaged macOS web service.'
      }
    })
    const empty = evaluateMacSignatureGate({
      credentialsPresent: true,
      reading: { schemaVersion: 1 }
    })

    expect(missing.reason).toContain('no reading file was written at all')
    expect(unreadable.reason).toContain(
      'the run never read the bundle: SMOKE_TIMEOUT: Timed out waiting for the packaged macOS web service.'
    )
    expect(empty.reason).toContain('no usable signature fields')
    // Three different next steps, three different sentences — and none of the three is a pass.
    for (const decision of [missing, unreadable, empty]) {
      expect(decision).toMatchObject({ ok: false, macSignature: 'unproven' })
    }
    expect(new Set([missing.reason, unreadable.reason, empty.reason]).size).toBe(3)

    // An unreadable reading with no reason says exactly that instead of inventing one.
    expect(unobservedDetail({ readable: false, signed: false })).toContain('carried no reason')
    expect(unobservedDetail({ readable: false, signed: false, reason: '   ' })).toContain(
      'carried no reason'
    )
    expect(
      unobservedDetail({ readable: false, signed: false, reason: 'ENOENT: no such file' })
    ).toContain('ENOENT: no such file')
    expect(unobservedDetail('not an object')).toContain('did not contain an object')
    expect(unobservedDetail(null)).toContain('no reading file was written at all')
  })

  it('keeps the source of an unusable reading, so "failed before reading" is not "not-read"', () => {
    expect(
      macSignatureEvidence({
        credentialsPresent: true,
        reading: {
          schemaVersion: 1,
          source: 'smoke-failure',
          readable: false,
          signed: false,
          reason: 'boom'
        }
      }).macSignatureEvidence.readingSource
    ).toBe('smoke-failure')

    // No file at all stays "not-read": those two must never look the same in the evidence record.
    expect(
      macSignatureEvidence({ credentialsPresent: true, reading: undefined }).macSignatureEvidence
        .readingSource
    ).toBe('not-read')

    // An observed reading still reports its own source, not the fallback.
    expect(
      macSignatureEvidence({ credentialsPresent: true, reading: signedReading })
        .macSignatureEvidence.readingSource
    ).toBe('shipped-zip')
  })

  it('reads a Developer ID signature and an ad-hoc signature apart', () => {
    expect(
      parseCodesignDescription(DEVELOPER_ID_DESCRIPTION, { expectedTeamId: TEST_TEAM_ID })
    ).toEqual({
      identifier: 'com.zerolink.purescience',
      teamIdentifier: TEST_TEAM_ID,
      signerTeam: TEST_TEAM_ID,
      teamIdExpectation: 'configured',
      signed: true
    })
    expect(parseCodesignDescription(AD_HOC_DESCRIPTION, { expectedTeamId: TEST_TEAM_ID })).toEqual({
      identifier: 'com.zerolink.purescience',
      teamIdentifier: 'not set',
      signerTeam: null,
      teamIdExpectation: 'configured',
      signed: false
    })
    // A certificate from another team is not a signed mac release for this updater.
    expect(
      parseCodesignDescription(`TeamIdentifier=${OTHER_TEAM_ID}`, { expectedTeamId: TEST_TEAM_ID })
        .signed
    ).toBe(false)
    // Nor is a signature nobody can attribute to this project (no expectation provisioned).
    expect(
      parseCodesignDescription(`TeamIdentifier=${TEST_TEAM_ID}`, { expectedTeamId: '' })
    ).toMatchObject({
      signerTeam: TEST_TEAM_ID,
      teamIdExpectation: 'not-configured',
      signed: false
    })
  })

  it('reports an unreadable bundle as unobserved rather than as unsigned', () => {
    const reading = readMacBundleSignature('/nonexistent/PureScience.app', {
      expectedTeamId: TEST_TEAM_ID
    })

    expect(reading.readable).toBe(false)
    expect(reading.signed).toBe(false)
    expect(readingIsObserved(reading)).toBe(false)
    expect(readingIsObserved(unsignedReading)).toBe(true)
    expect(readingIsObserved({ signed: 'yes' })).toBe(false)
  })
})

describe('mac signing disclosure', () => {
  it('states the unsigned facts and the unverified state without claiming either as signed', () => {
    expect(macSigningDisclosure('signed')).toBeUndefined()
    expect(macSigningDisclosure('unsigned')).toContain(MAC_SIGNING_DISCLOSURE_MARKER)
    expect(macSigningDisclosure('unsigned')).toContain('unsigned**')
    expect(macSigningDisclosure('unsigned')).toContain(
      'in-place auto-update is unavailable on macOS'
    )
    expect(macSigningDisclosure('unproven')).toContain('not established**')
    expect(macSigningDisclosure('unproven')).not.toContain('unsigned**')
  })

  it('derives the worst mac arm from the aggregated certification record', () => {
    const record = (
      states: string[]
    ): { platforms: { macSignature: string; platform: string }[] } => ({
      platforms: states.map((macSignature, index) => ({
        platform: index === 0 ? 'macos-arm64' : 'macos-x64',
        macSignature
      }))
    })

    expect(macSigningDisclosureFromRecord(record(['signed', 'signed']))).toBeUndefined()
    expect(macSigningDisclosureFromRecord(record(['unsigned', 'signed']))).toContain('unsigned**')
    expect(macSigningDisclosureFromRecord(record(['signed', 'unproven']))).toContain(
      'not established**'
    )
    // A record predating the field states nothing it cannot support.
    expect(macSigningDisclosureFromRecord(record([undefined as unknown as string]))).toContain(
      'not established**'
    )
    expect(
      macSigningDisclosureFromRecord({ platforms: [{ platform: 'linux-x64' }] })
    ).toBeUndefined()
    expect(macSigningDisclosureFromRecord(undefined)).toBeUndefined()
  })

  it('adds, replaces, and removes the disclosure line in a release body without touching the rest', () => {
    const body = "## Maturity\n\nstuff\n\n---\n\n## What's Changed\n* x by @y in #1"

    const disclosed = ensureDisclosureInBody(body, macSigningDisclosure('unsigned'))
    expect(disclosed).toContain('## Maturity')
    expect(disclosed).toContain('* x by @y in #1')
    expect(disclosed).toContain(MAC_SIGNING_DISCLOSURE_MARKER)
    // Idempotent: re-running on an already-disclosed body changes nothing.
    expect(ensureDisclosureInBody(disclosed, macSigningDisclosure('unsigned'))).toBe(disclosed)

    // A different state replaces the line in place instead of stacking a second one.
    const replaced = ensureDisclosureInBody(disclosed, macSigningDisclosure('unproven'))
    expect(replaced.match(/macOS signing status/g)).toHaveLength(1)
    expect(replaced).toContain('not established**')

    // Signed assets drop a stale disclosure.
    const cleaned = ensureDisclosureInBody(replaced, undefined)
    expect(cleaned).not.toContain(MAC_SIGNING_DISCLOSURE_MARKER)
    expect(cleaned).toContain('* x by @y in #1')
    // Nothing to do, nothing to rewrite.
    expect(ensureDisclosureInBody(body, undefined)).toBe(body)
  })
})
