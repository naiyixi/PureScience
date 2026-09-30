/* eslint-disable @typescript-eslint/explicit-function-return-type */
//
// macOS signing status, in one place (issue #19).
//
// The notarize-mac job no-ops when the Apple credentials are absent, and a no-op job is
// indistinguishable from a real one in the checks list: "Notarize + staple arm64 | success" got read
// as "the mac build is notarized" while the published assets were not even Developer ID signed. Every
// surface that reports or records the mac signing state goes through this module, so the state is
// always a reading (or an explicit "not observed"), never an assumption:
//
//   - evaluateMacSignatureGate — the decision. Fail closed when credentials ARE configured and the
//                               assets are not Developer ID signed; report unsigned without failing
//                               when the credentials were never configured; refuse to call an
//                               unobserved asset a pass either way.
//   - macSignatureEvidence     — the machine-readable fields the certification record carries.
//   - macSigningDisclosure     — the sentence the release page must carry when the mac assets are
//                               not signed (or the state was never established).
//
// Usage (CI):
//   node scripts/ci/mac-signing-status.mjs verify --credentials present --reading <reading.json>
//   node scripts/ci/mac-signing-status.mjs disclose --record RELEASE-CERTIFICATION.json --tag v1.2.3
//   node scripts/ci/mac-signing-status.mjs read --app dist/mac-arm64/PureScience.app
//   node scripts/ci/mac-signing-status.mjs note --state unsigned
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The Developer ID team the shipped mac builds must carry. Mirrors OFFICIAL_MAC_TEAM_ID in
// src/main/update/create-strategy.ts: Squirrel.Mac only accepts a replacement bundle signed by the
// same team, so "signed" means "signed by THIS team" — an ad-hoc signature (TeamIdentifier=not set)
// or a certificate from another team is not a signed mac release.
export const OFFICIAL_MAC_TEAM_ID = '87G9WFU9H3'
export const MAC_SIGNATURE_STATES = ['signed', 'unsigned', 'unproven']

// The release page marks the disclosure with this exact prefix; scripts/release-notes.mjs keeps a
// line with this prefix across a re-composition, so the fact cannot be silently dropped by a later
// rewrite (and this step can replace or remove it in place).
export const MAC_SIGNING_DISCLOSURE_MARKER = '> ⚠️ **macOS signing status'

const MAC_SIGNED_DISCLOSURE =
  `${MAC_SIGNING_DISCLOSURE_MARKER}: unsigned** — the macOS packages in this release carry only an ` +
  'ad-hoc signature (no Apple Developer ID credentials are configured), so Gatekeeper warns on first ' +
  'launch and **in-place auto-update is unavailable on macOS**. Install the DMG manually ' +
  '(right-click → Open, or `xattr -dr com.apple.quarantine "<app>"`).'

const MAC_UNPROVEN_DISCLOSURE =
  `${MAC_SIGNING_DISCLOSURE_MARKER}: not established** — no signature reading is recorded for the ` +
  'macOS packages in this release, so nothing here claims they are signed or notarized. Treat macOS ' +
  'in-place auto-update as unavailable until a release records `macSignature: signed`.'

// The disclosure is one line on purpose: a single marker line is what makes it idempotent to add,
// replace, or remove in a body that other steps also rewrite.
export const macSigningDisclosure = (macSignature) => {
  if (macSignature === 'unsigned') return MAC_SIGNED_DISCLOSURE
  if (macSignature === 'unproven') return MAC_UNPROVEN_DISCLOSURE
  return undefined
}

// `codesign -d` writes its description to stderr and still exits 0, so the reading is taken from the
// merged output. An ad-hoc signature reports `TeamIdentifier=not set`; only the shipping Developer ID
// carries the team.
export const parseCodesignDescription = (text) => {
  const description = String(text ?? '')
  const identifier = description.match(/^Identifier=(.+)$/m)?.[1]?.trim()
  const teamIdentifier = description.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim()
  return {
    identifier: identifier ?? null,
    teamIdentifier: teamIdentifier ?? null,
    signed: teamIdentifier === OFFICIAL_MAC_TEAM_ID
  }
}

// Read a bundle's signature on this machine. Never throws: an unreadable bundle is an UNOBSERVED
// reading (readable: false), which the gate treats as "not a pass" rather than as "unsigned".
export const readMacBundleSignature = (bundlePath, { source = 'app-directory', artifact } = {}) => {
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', bundlePath], {
    encoding: 'utf8'
  })
  const parsed = parseCodesignDescription(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  const readable = Boolean(parsed.identifier || parsed.teamIdentifier)
  return {
    schemaVersion: 1,
    source,
    artifact: artifact ?? bundlePath,
    bundle: bundlePath,
    readable,
    identifier: parsed.identifier,
    teamIdentifier: parsed.teamIdentifier,
    signed: readable && parsed.signed
  }
}

// An observed reading carries a boolean `signed` and was not flagged unreadable. Anything else
// (missing file, no `signed` field, readable: false) is unobserved.
export const readingIsObserved = (reading) =>
  Boolean(reading) &&
  typeof reading === 'object' &&
  reading.readable !== false &&
  typeof reading.signed === 'boolean'

export const evaluateMacSignatureGate = ({ credentialsPresent, reading } = {}) => {
  const configured = credentialsPresent === true
  const observed = readingIsObserved(reading)
  const signed = observed && reading.signed === true

  if (configured && signed) {
    return {
      macSignature: 'signed',
      ok: true,
      reason:
        'Apple credentials are configured and the macOS asset is Developer ID signed ' +
        `(TeamIdentifier=${reading.teamIdentifier}).`
    }
  }
  if (configured && observed) {
    return {
      macSignature: 'unsigned',
      ok: false,
      reason:
        'Apple credentials are configured but the macOS asset is NOT Developer ID signed ' +
        `(TeamIdentifier=${reading.teamIdentifier ?? 'not set'}) — a credentialed run must not ` +
        'record or publish an unsigned macOS asset.'
    }
  }
  if (configured) {
    return {
      macSignature: 'unproven',
      ok: false,
      reason:
        'Apple credentials are configured but the macOS asset signature was never read — ' +
        'unobserved is not a pass.'
    }
  }
  if (signed) {
    return {
      macSignature: 'signed',
      ok: true,
      reason:
        'The macOS asset is Developer ID signed ' +
        `(TeamIdentifier=${reading.teamIdentifier}); no credentials were needed in this run.`
    }
  }
  if (observed) {
    return {
      macSignature: 'unsigned',
      ok: true,
      reason:
        'No Apple credentials are configured, so the macOS asset stays ad-hoc signed — recorded ' +
        'as unsigned, never as verified.'
    }
  }
  return {
    macSignature: 'unproven',
    ok: false,
    reason:
      'The macOS asset signature was not read and no credentials are configured — an unobserved ' +
      'state must not be recorded as a pass.'
  }
}

// The fields the certification record carries, next to the state they came from.
export const macSignatureEvidence = ({ credentialsPresent, reading } = {}) => {
  const { macSignature } = evaluateMacSignatureGate({ credentialsPresent, reading })
  const observed = readingIsObserved(reading)
  return {
    macSignature,
    macSignatureEvidence: {
      credentialsPresent: credentialsPresent === true,
      teamIdExpected: OFFICIAL_MAC_TEAM_ID,
      identifier: observed ? (reading.identifier ?? null) : null,
      teamIdentifier: observed ? (reading.teamIdentifier ?? null) : null,
      readingSource: observed ? (reading.source ?? 'unknown') : 'not-read'
    }
  }
}

// The disclosure a release body must carry, derived from an aggregated RELEASE-CERTIFICATION.json.
// undefined means "no mac state recorded in this file" (nothing to say); an unrecorded state on a
// mac release is reported as unproven, never as signed.
export const macSigningDisclosureFromRecord = (record) => {
  const macRecords = Array.isArray(record?.platforms)
    ? record.platforms.filter((entry) => String(entry?.platform ?? '').startsWith('macos-'))
    : []
  if (macRecords.length === 0) return undefined

  // Worst of the two arms: a signed x64 paired with an unsigned arm64 is an unsigned mac release.
  const rank = { signed: 0, unproven: 1, unsigned: 2 }
  const states = macRecords.map((entry) =>
    MAC_SIGNATURE_STATES.includes(entry?.macSignature) ? entry.macSignature : 'unproven'
  )
  const worst = [...states].sort((a, b) => rank[b] - rank[a])[0]
  return macSigningDisclosure(worst)
}

// Idempotent body update: appends the disclosure, replaces the line in place when the state text
// changed, or drops it when the state is signed. Returns the body unchanged when there is nothing to
// do, so a caller can compare and skip the upload. Deliberately no `---` separator of its own: a
// marker line plus surrounding blank lines is the whole block, which is what makes re-running this
// over its own output a no-op.
export const ensureDisclosureInBody = (body, disclosure) => {
  const text = String(body ?? '')
  const lines = text.split('\n')
  const hasMarker = lines.some((line) => line.startsWith(MAC_SIGNING_DISCLOSURE_MARKER))
  if (!hasMarker && !disclosure) return text

  const cleaned = lines
    .filter((line) => !line.startsWith(MAC_SIGNING_DISCLOSURE_MARKER))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')
  if (!disclosure) return `${cleaned}\n`
  return `${cleaned}\n\n${disclosure}\n`
}

export const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'))
  } catch {
    return undefined
  }
}

const argumentValue = (argv, name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const summarise = ({ ok, macSignature, reason }) =>
  `${ok ? 'ok' : 'FAIL'} — macSignature=${macSignature}: ${reason}`

const reportToStepSummary = (section) => {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (path) appendFileSync(path, section)
  process.stdout.write(section.endsWith('\n') ? section : `${section}\n`)
}

const verifyCommand = (argv) => {
  const credentials = argumentValue(argv, '--credentials')
  if (!['present', 'absent'].includes(credentials)) {
    throw new Error(
      'Usage: verify --credentials <present|absent> --reading <path> [--label <name>]'
    )
  }
  const readingArgument = argumentValue(argv, '--reading')
  const label = argumentValue(argv, '--label') ?? 'macOS signing'
  const reading =
    readingArgument && readingArgument !== 'none' ? readJsonFile(readingArgument) : undefined
  const decision = evaluateMacSignatureGate({
    credentialsPresent: credentials === 'present',
    reading
  })

  console.log(`${label}: ${summarise(decision)}`)
  // The uncredentialed unsigned case is the one that used to pass unnoticed, so it gets an annotation
  // of its own; the credentialed failure already carries an ::error:: below.
  if (decision.macSignature === 'unsigned' && credentials === 'absent') {
    console.log(
      `::warning::${label}: the macOS assets are NOT signed and NOT notarized (no Apple Developer ID ` +
        'credentials configured).'
    )
  }
  const section =
    `## ${label}\n\n` +
    `- result: **${decision.ok ? 'ok' : 'FAIL'}**\n` +
    `- macSignature: **${decision.macSignature}**\n` +
    `- credentials configured: ${credentials === 'present'}\n` +
    `- signature reading: ${
      readingIsObserved(reading)
        ? `Identifier=${reading.identifier ?? '<none>'}, TeamIdentifier=${reading.teamIdentifier ?? '<none>'} (${reading.source ?? 'unknown'})`
        : '**not observed**'
    }\n\n${decision.reason}\n`
  reportToStepSummary(section)

  if (!decision.ok) {
    console.error(`::error::${label}: ${summarise(decision)}`)
    process.exitCode = 1
  }
  return decision
}

const readCommand = (argv) => {
  const app = argumentValue(argv, '--app')
  if (!app) throw new Error('Usage: read --app <bundle path> [--source <label>]')
  const reading = readMacBundleSignature(resolve(app), {
    source: argumentValue(argv, '--source') ?? 'app-directory'
  })
  process.stdout.write(reading.signed ? 'signed\n' : reading.readable ? 'unsigned\n' : 'unproven\n')
  return reading
}

const noteCommand = (argv) => {
  const recordArgument = argumentValue(argv, '--record')
  const state = argumentValue(argv, '--state')
  let disclosure
  if (recordArgument) {
    const record = readJsonFile(recordArgument)
    if (!record) throw new Error(`note: cannot read the certification record at ${recordArgument}`)
    disclosure = macSigningDisclosureFromRecord(record)
  } else {
    if (!MAC_SIGNATURE_STATES.includes(state)) {
      throw new Error('Usage: note (--state <signed|unsigned|unproven> | --record <path>)')
    }
    disclosure = macSigningDisclosure(state)
  }
  if (disclosure) process.stdout.write(`${disclosure}\n`)
  return disclosure
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' }).trim()

const discloseCommand = (argv) => {
  const recordArgument = argumentValue(argv, '--record')
  const tag = argumentValue(argv, '--tag')
  if (!recordArgument || !tag) {
    throw new Error('Usage: disclose --record <RELEASE-CERTIFICATION.json> --tag <tag>')
  }
  const record = readJsonFile(recordArgument)
  if (!record)
    throw new Error(`disclose: cannot read the certification record at ${recordArgument}`)

  const disclosure = macSigningDisclosureFromRecord(record)
  const body = gh(['release', 'view', tag, '--json', 'body', '--jq', '.body'])
  const updated = ensureDisclosureInBody(body, disclosure)
  if (updated === body) {
    console.log(
      `mac-signing-status: release ${tag} already states the macOS signing status ` +
        `(${disclosure ? 'disclosed' : 'signed — no disclosure needed'}).`
    )
    return updated
  }

  const file = join(tmpdir(), `purescience-mac-signing-disclosure-${tag}.md`)
  writeFileSync(file, updated)
  gh(['release', 'edit', tag, '--notes-file', file])
  console.log(
    `mac-signing-status: ${disclosure ? 'recorded the unsigned macOS state on' : 'removed the stale macOS disclosure from'} ${tag}`
  )
  return updated
}

const main = () => {
  const argv = process.argv.slice(2)
  if (argv[0] === 'verify') verifyCommand(argv.slice(1))
  else if (argv[0] === 'read') readCommand(argv.slice(1))
  else if (argv[0] === 'note') noteCommand(argv.slice(1))
  else if (argv[0] === 'disclose') discloseCommand(argv.slice(1))
  else throw new Error('Expected a mac signing status command: verify | read | note | disclose')
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
