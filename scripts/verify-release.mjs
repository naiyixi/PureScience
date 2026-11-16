/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Release acceptance in one command: page ↔ assets ↔ digests ↔ commit.
//
// Why this exists: every release round re-derived the same verdict by hand from `gh release view`
// plus a remembered list of asset names, and that list drifted — a shorter remembered list once
// reported "assets are incomplete" on a complete page, and a differently-cased probe once selected
// zero assets and reported "the certification record is missing". Both were instrument errors, not
// release defects. The checks below are derived from what the pipeline actually uploads
// (`.github/workflows/release.yml`, `electron-builder.yml`) and from the record it writes, so the
// verdict is a reading rather than a recollection.
//
// What this is NOT: it cannot tell you the assets are *correct*, only that every family the pipeline
// promises is on the page, that the page is published, that `SHA256SUMS.txt` and the certification
// record agree on the digests they both list, that the record names the commit the tag points at, and
// that the release body is not the raw generator output. A family whose presence depends on the path
// that produced the mac artifacts (the four mac blockmaps) is reported by name rather than demanded —
// demanding them made a correctly published notarized page read as incomplete, and ignoring them would
// hide a real loss on the unnotarized path. Signing is reported verbatim from the record
// and never inferred from a green job: an unsigned release is accepted (that was the shipped state
// before credentials existed) unless `--require-signed` asks for a Developer ID signature.
//
// House rule learned the hard way here: a gate may only demand a literal that its *producer* writes.
// `--require-signed` first demanded `macSignature === 'developer-id'` — a word the recorder
// (`scripts/ci/mac-signing-status.mjs`) never emits, since it writes `signed`/`unsigned`/`unproven` —
// so the check passed its own fixture and could never pass on a real page, while its failure line read
// "signing required but record says: signed". Requirements now go through `signingEvidenceGap`, which
// takes the producer's word *and* the evidence that attributes it.
//
// Usage:
//   node scripts/verify-release.mjs v2.27.0
//   node scripts/verify-release.mjs v2.27.0 --json --require-signed
//   node scripts/verify-release.mjs v2.27.0 --assess-installers --require-notarized
//   node scripts/verify-release.mjs nightly --allow-prerelease --min-body-bytes 0
//
// Exit code 0 only when every hard check passes.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_MIN_BODY_BYTES = 2000

// Every family the release pipeline always promises, as a name suffix. A missing member is a named
// failure. The four mac blockmaps are NOT here on purpose: `notarize-mac.yml` re-emits the stapled
// dmg/zip and drops the pre-staple blockmaps, because a blockmap computed over bytes that no longer
// exist would describe a differential patch nobody can apply — the notarized mac path ships full-zip
// updates in v1 (see that workflow's "Regenerate mac update feed" comment). An unsigned/unnotarized
// release still carries them, so their presence is reported by name (see `planConditionalAssets`)
// instead of being demanded or ignored.
export const planRequiredAssets = (version) => [
  { id: 'mac-arm64-dmg', suffix: '-mac-arm64.dmg' },
  { id: 'mac-arm64-zip', suffix: '-mac-arm64.zip' },
  { id: 'mac-x64-dmg', suffix: '-mac-x64.dmg' },
  { id: 'mac-x64-zip', suffix: '-mac-x64.zip' },
  { id: 'linux-appimage', suffix: '-linux-x86_64.AppImage' },
  { id: 'linux-deb', suffix: `_${version}_amd64.deb` },
  { id: 'win-setup', suffix: '-win-x64-setup.exe' },
  { id: 'win-setup-blockmap', suffix: '-win-x64-setup.exe.blockmap' },
  { id: 'win-zip', suffix: '-win-x64.zip' },
  { id: 'sha256sums', suffix: 'SHA256SUMS.txt' },
  { id: 'certification', suffix: 'RELEASE-CERTIFICATION.json' },
  { id: 'version-manifest', suffix: 'version.json' },
  { id: 'feed-win', suffix: 'latest.yml' },
  { id: 'feed-linux', suffix: 'latest-linux.yml' },
  { id: 'feed-mac', suffix: 'latest-mac.yml' },
  { id: 'feed-mac-arm64', suffix: 'arm64-mac.yml' },
  { id: 'feed-mac-x64', suffix: 'x64-mac.yml' }
]

// Families whose presence depends on which path produced the mac artifacts. Reported, never silently
// dropped: a page without them gets a reading that names why they are absent, so "missing" and
// "deliberately not produced on this path" stay two different answers.
export const planConditionalAssets = () => [
  { id: 'mac-arm64-dmg-blockmap', suffix: '-mac-arm64.dmg.blockmap' },
  { id: 'mac-arm64-zip-blockmap', suffix: '-mac-arm64.zip.blockmap' },
  { id: 'mac-x64-dmg-blockmap', suffix: '-mac-x64.dmg.blockmap' },
  { id: 'mac-x64-zip-blockmap', suffix: '-mac-x64.zip.blockmap' }
]

const versionFromTag = (tag) => tag.replace(/^v/, '')

const check = (name, ok, detail, hardFailure = true) => ({ name, ok, detail, hardFailure })

// `SHA256SUMS.txt` lines are `<digest>  <name>` (two spaces, coreutils style). Anything else is
// ignored rather than guessed at, and the count of parsed lines is reported so a parser that silently
// matched nothing cannot read as agreement.
export const parseSha256Sums = (text) => {
  const digests = new Map()
  for (const line of (text ?? '').split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trimEnd())
    if (match) digests.set(match[2], match[1])
  }
  return digests
}

// The certification record is `{schemaVersion, sourceSha, platforms[]}`; each platform carries its own
// `macSignature` (+ evidence) and the artifacts it produced with their digests.
export const readCertification = (record) => {
  const platforms = Array.isArray(record?.platforms) ? record.platforms : []
  const artifacts = new Map()
  const macSigning = []
  for (const platform of platforms) {
    for (const artifact of Array.isArray(platform?.artifacts) ? platform.artifacts : []) {
      if (typeof artifact?.name === 'string' && typeof artifact?.sha256 === 'string') {
        artifacts.set(artifact.name, artifact.sha256)
      }
    }
    if (typeof platform?.macSignature === 'string') {
      macSigning.push({
        platform: platform.platform ?? '(unnamed)',
        macSignature: platform.macSignature,
        credentialsPresent: platform.macSignatureEvidence?.credentialsPresent,
        evidence: platform.macSignatureEvidence ?? null
      })
    }
  }
  return {
    sourceSha: typeof record?.sourceSha === 'string' ? record.sourceSha : '',
    artifacts,
    macSigning
  }
}

// What `--require-signed` actually demands. The recorder (`scripts/ci/mac-signing-status.mjs`) writes
// `signed` / `unsigned` / `unproven`, and `signed` already means "signed by the team this project
// provisions" — but only because the same record carries the team the state was read from. So the gate
// requires the state *and* the evidence that makes it attributable; a record that merely asserts
// `signed` with nothing to attribute it to is `unproven` wearing a better word. Both vocabulary
// mistakes are possible and both were made once: demanding a literal the recorder never writes
// (`developer-id`) made a notarized, stapled release read as unsigned, and accepting the literal alone
// would let a claim with no team pass. Returns null when the entry establishes the property, else a
// short gap string that becomes part of the failing line.
export const signingEvidenceGap = (entry) => {
  if (entry?.macSignature !== 'signed') {
    return `macSignature=${typeof entry?.macSignature === 'string' ? entry.macSignature : 'absent'}`
  }
  const evidence = entry.evidence ?? {}
  const team = typeof evidence.teamIdentifier === 'string' ? evidence.teamIdentifier.trim() : ''
  if (team === '' || team === 'not set') return 'signed with no attributable TeamIdentifier'
  const expected = typeof evidence.teamIdExpected === 'string' ? evidence.teamIdExpected.trim() : ''
  if (evidence.teamIdExpectation === 'configured' && expected !== '' && team !== expected) {
    return `TeamIdentifier=${team} is not the expected ${expected}`
  }
  if (typeof evidence.readingSource !== 'string' || evidence.readingSource.trim() === '') {
    return 'signed with no readingSource (asserted, not observed)'
  }
  return null
}

// Gatekeeper's own verdict on a shipped installer, parsed from the two tools a user's Mac effectively
// runs: `spctl -a -t open --context context:primary-signature` (assess the disk image) and
// `xcrun stapler validate` (is a notarization ticket actually attached). Kept pure and separate from
// the record's `macSignature`: the record is what the pipeline believed, this is what the OS says, and
// the two can disagree — a Developer ID signature with no stapled ticket is exactly that case.
// Nothing unreadable is ever reported as a pass: an empty or unrecognised output is `unreadable`.
export const parseGatekeeperAssessment = ({
  spctlStatus,
  spctlStdout = '',
  spctlStderr = '',
  staplerStatus,
  staplerStdout = '',
  staplerStderr = ''
}) => {
  const spctlText = `${spctlStdout}\n${spctlStderr}`
  const verdictMatch = spctlText
    .split(/\r?\n/)
    .map((line) => line.match(/^(.+?):\s+(accepted|rejected)\s*$/))
    .find(Boolean)
  // A tool that never ran has not answered anything: `spawnSync` reports status null when `spctl` is
  // missing, and that must not be mistaken for an unrecognised answer from a tool that did run.
  const ran = typeof spctlStatus === 'number'
  const verdict = ran && verdictMatch ? verdictMatch[2] : 'unreadable'
  const sourceMatch = spctlText.match(/^\s*source=(.+)$/m)
  const source = sourceMatch ? sourceMatch[1].trim() : null

  const staplerText = `${staplerStdout}\n${staplerStderr}`
  let stapled = 'unreadable'
  if (staplerStatus === 0 && /The validate action worked/i.test(staplerText)) {
    stapled = 'valid'
  } else if (/does not have a ticket|no ticket|not stapled/i.test(staplerText)) {
    stapled = 'missing'
  }

  return { verdict, source, stapled }
}

// Pure evaluation: everything it needs is passed in, so the verdict is testable without a network.
export const evaluateRelease = ({
  tag,
  release,
  assetNames,
  certification,
  sha256SumsText,
  headSha,
  minBodyBytes = DEFAULT_MIN_BODY_BYTES,
  allowPrerelease = false,
  requireSigned = false,
  requireNotarized = false,
  installerAssessments = null,
  gatekeeperSkipReason,
  certificationSkipReason,
  sha256SumsSkipReason
}) => {
  const checks = []

  checks.push(
    check(
      'page-exists',
      Boolean(release),
      release
        ? `${release.tagName} published ${release.publishedAt ?? '(no date)'}`
        : 'gh reported no such release'
    )
  )

  const draft = release?.isDraft === true
  checks.push(check('page-not-draft', !draft, draft ? 'the page is still a draft' : 'draft=false'))

  const prerelease = release?.isPrerelease === true
  checks.push(
    check(
      'page-not-prerelease',
      allowPrerelease || !prerelease,
      prerelease
        ? allowPrerelease
          ? 'prerelease, allowed by flag'
          : 'the page is a prerelease'
        : 'isPrerelease=false'
    )
  )

  const planned = planRequiredAssets(versionFromTag(tag))
  const present = new Set(assetNames ?? [])
  const missing = []
  for (const entry of planned) {
    if (![...present].some((assetName) => assetName.endsWith(entry.suffix))) {
      missing.push(`${entry.id} (…${entry.suffix})`)
    }
  }
  checks.push(
    check(
      'assets-complete',
      missing.length === 0,
      missing.length === 0
        ? `${planned.length} families present of ${present.size} assets`
        : `missing ${missing.length}: ${missing.join(', ')}`
    )
  )

  // Conditional families: present or absent both pass, but the reading says which and why. A page that
  // silently lost them would still be visible here instead of being absorbed by the required list.
  const conditional = planConditionalAssets()
  const conditionalPresent = conditional.filter((entry) =>
    [...present].some((assetName) => assetName.endsWith(entry.suffix))
  )
  const conditionalAbsent = conditional.filter((entry) => !conditionalPresent.includes(entry))
  checks.push(
    check(
      'mac-blockmaps',
      true,
      conditionalAbsent.length === 0
        ? `${conditionalPresent.length}/${conditional.length} mac blockmaps published (unnotarized path)`
        : `${conditionalAbsent.length}/${conditional.length} mac blockmaps not published — ${conditionalAbsent.map((e) => e.id).join(', ')}; the notarized re-emit drops pre-staple blockmaps by design (full-zip mac updates in v1)`,
      false
    )
  )

  const body = release?.body ?? ''
  const bodyBytes = Buffer.byteLength(body, 'utf8')
  checks.push(
    check('body-length', bodyBytes >= minBodyBytes, `${bodyBytes} bytes (floor ${minBodyBytes})`)
  )

  const noiseLines = body
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('release-notes:'))
  checks.push(
    check(
      'body-no-generator-noise',
      noiseLines.length === 0,
      noiseLines.length === 0
        ? 'no release-notes: lines'
        : `${noiseLines.length} line(s) start with release-notes:`
    )
  )

  if (certificationSkipReason) {
    checks.push(check('certification-read', false, certificationSkipReason))
    checks.push(
      check('source-sha-matches-tag', false, 'not compared — the record could not be read')
    )
    checks.push(
      check('record-artifacts-on-page', false, 'not compared — the record could not be read')
    )
  } else {
    checks.push(
      check(
        'certification-read',
        Boolean(certification),
        certification ? 'record read' : 'record empty'
      )
    )
    const record = readCertification(certification)
    const matches = Boolean(headSha) && record.sourceSha === headSha
    checks.push(
      check(
        'source-sha-matches-tag',
        matches,
        matches
          ? record.sourceSha
          : `record says ${record.sourceSha || '(absent)'}, tag points at ${headSha || '(unknown)'}`
      )
    )
    const absent = [...record.artifacts.keys()].filter((name) => !present.has(name))
    checks.push(
      check(
        'record-artifacts-on-page',
        absent.length === 0,
        absent.length === 0
          ? `${record.artifacts.size} recorded artifact(s) all on the page`
          : `${absent.length} recorded artifact(s) not on the page: ${absent.join(', ')}`
      )
    )
  }

  // The two digest sources must agree; a sums line we never parsed is reported as a count, not a pass.
  if (certificationSkipReason || sha256SumsSkipReason) {
    checks.push(
      check(
        'sha256sums-match-record',
        false,
        certificationSkipReason ?? sha256SumsSkipReason ?? 'not compared'
      )
    )
  } else {
    const record = readCertification(certification)
    const sums = parseSha256Sums(sha256SumsText)
    const mismatched = []
    let compared = 0
    for (const [name, digest] of sums) {
      const recorded = record.artifacts.get(name)
      if (recorded === undefined) continue
      compared += 1
      if (recorded !== digest)
        mismatched.push(`${name} (sums ${digest.slice(0, 12)}… record ${recorded.slice(0, 12)}…)`)
    }
    const uncovered = [...record.artifacts.keys()].filter((name) => !sums.has(name))
    checks.push(
      check(
        'sha256sums-match-record',
        compared > 0 && mismatched.length === 0,
        mismatched.length > 0
          ? `${mismatched.length} digest mismatch(es): ${mismatched.join(', ')}`
          : compared === 0
            ? `no artifact name appears in both lists (parsed ${sums.size} sums line(s))`
            : `${compared} digest(s) equal; ${uncovered.length} record artifact(s) absent from the sums file`
      )
    )
    if (uncovered.length > 0) {
      checks.push(
        check(
          'sha256sums-covers-record',
          false,
          `not in SHA256SUMS.txt: ${uncovered.join(', ')}`,
          false
        )
      )
    }
  }

  // Signing is a reading, never an inference: the record carries it, or we say we did not observe it.
  const { macSigning } = readCertification(certification)
  if (macSigning.length > 0) {
    const line = macSigning
      .map(
        (entry) =>
          `${entry.platform}=${entry.macSignature} (credentialsPresent=${
            entry.credentialsPresent === true
              ? 'true'
              : entry.credentialsPresent === false
                ? 'false'
                : 'not recorded'
          })`
      )
      .join('; ')
    const gaps = macSigning
      .map((entry) => ({ platform: entry.platform, gap: signingEvidenceGap(entry) }))
      .filter(({ gap }) => gap !== null)
    const signed = gaps.length === 0
    checks.push(
      check(
        'mac-signing-observed',
        !requireSigned || signed,
        requireSigned && !signed
          ? `signing required but not established: ${gaps
              .map(({ platform, gap }) => `${platform}: ${gap}`)
              .join('; ')} (record says: ${line})`
          : line
      )
    )
  } else {
    checks.push(
      check(
        'mac-signing-observed',
        !requireSigned,
        requireSigned
          ? 'the certification record carries no macSignature — refusing to call this signed'
          : 'the certification record carries no macSignature (not observed; pass --require-signed to make it fatal)'
      )
    )
  }

  // Gatekeeper's own verdict on the shipped installers. `--require-signed` above reads what the record
  // claims; this reads what the OS decides, and only when the caller asked for it (it downloads the
  // dmgs). Three shapes stay distinct: never asked, asked but this host cannot run spctl, and asked
  // with nothing to assess — none of them is reported as a pass.
  if (gatekeeperSkipReason) {
    checks.push(check('gatekeeper-assessed', false, gatekeeperSkipReason, requireNotarized))
  } else if (installerAssessments === null) {
    checks.push(
      check(
        'gatekeeper-assessed',
        !requireNotarized,
        requireNotarized
          ? 'no installer was assessed — Gatekeeper was never asked, so nothing here proves notarization'
          : 'Gatekeeper was not asked to assess any installer (pass --assess-installers to add this reading)',
        requireNotarized
      )
    )
  } else if (installerAssessments.length === 0) {
    checks.push(
      check(
        'gatekeeper-assessed',
        false,
        'no mac dmg was found on the page, so there was nothing to hand to spctl',
        requireNotarized
      )
    )
  } else {
    for (const entry of installerAssessments) {
      const notarized =
        entry.verdict === 'accepted' && /Notarized Developer ID/i.test(entry.source ?? '')
      checks.push(
        check(
          `gatekeeper:${entry.asset}`,
          requireNotarized ? notarized : entry.verdict === 'accepted',
          `${entry.verdict}${entry.source ? ` source=${entry.source}` : ''}`,
          requireNotarized
        )
      )
      checks.push(
        check(
          `stapled:${entry.asset}`,
          entry.stapled === 'valid',
          `stapler validate=${entry.stapled}`,
          requireNotarized
        )
      )
    }
  }

  const failures = checks.filter((c) => !c.ok && c.hardFailure)
  const warnings = checks.filter((c) => !c.ok && !c.hardFailure)
  return { ok: failures.length === 0, tag, checks, failures, warnings }
}

const run = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()

const argumentValue = (argv, flag) => {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

const main = () => {
  const argv = process.argv.slice(2)
  // The tag is the positional first argument, as documented; a flag value is never mistaken for it.
  const tag = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined
  if (!tag) {
    process.stderr.write(
      'usage: node scripts/verify-release.mjs <tag> [--repo owner/name] [--json] [--allow-prerelease] [--require-signed] [--assess-installers] [--require-notarized] [--min-body-bytes N]\n'
    )
    process.exit(2)
  }
  const repo = argumentValue(argv, '--repo') ?? 'naiyixi/PureScience'
  const asJson = argv.includes('--json')
  const allowPrerelease = argv.includes('--allow-prerelease')
  const requireSigned = argv.includes('--require-signed')
  const requireNotarized = argv.includes('--require-notarized')
  const assessInstallers = argv.includes('--assess-installers') || requireNotarized
  const minBodyBytes = Number(argumentValue(argv, '--min-body-bytes') ?? DEFAULT_MIN_BODY_BYTES)

  let release
  try {
    release = JSON.parse(
      run('gh', [
        'release',
        'view',
        tag,
        '--repo',
        repo,
        '--json',
        'name,tagName,isDraft,isPrerelease,publishedAt,body,assets'
      ])
    )
  } catch (error) {
    process.stderr.write(`verify-release: gh release view ${tag} failed: ${error.message}\n`)
    process.exit(1)
  }

  let headSha = ''
  try {
    headSha = run('git', ['rev-parse', `${tag}^{commit}`])
  } catch {
    headSha = ''
  }

  // Select and fetch by exact name: `gh api <asset-url>` does not follow the 302, and a differently
  // cased probe selects nothing — either one reads as "the record is missing".
  const directory = mkdtempSync(join(tmpdir(), 'purescience-release-verify-'))
  let certification
  let certificationSkipReason
  let sha256SumsText
  let sha256SumsSkipReason
  try {
    run('gh', [
      'release',
      'download',
      tag,
      '--repo',
      repo,
      '--pattern',
      'RELEASE-CERTIFICATION.json',
      '--dir',
      directory,
      '--clobber'
    ])
    certification = JSON.parse(readFileSync(join(directory, 'RELEASE-CERTIFICATION.json'), 'utf8'))
  } catch (error) {
    certificationSkipReason = `could not download RELEASE-CERTIFICATION.json: ${String(error.message).split('\n')[0]}`
  }
  try {
    run('gh', [
      'release',
      'download',
      tag,
      '--repo',
      repo,
      '--pattern',
      'SHA256SUMS.txt',
      '--dir',
      directory,
      '--clobber'
    ])
    sha256SumsText = readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8')
  } catch (error) {
    sha256SumsSkipReason = `could not download SHA256SUMS.txt: ${String(error.message).split('\n')[0]}`
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

  // Gatekeeper's verdict on the shipped mac installers, read from the bytes on the page rather than
  // from the record. Only attempted when asked: it downloads each dmg (~150 MB per architecture).
  let installerAssessments = null
  let gatekeeperSkipReason
  if (assessInstallers) {
    if (process.platform !== 'darwin') {
      installerAssessments = []
      gatekeeperSkipReason = `this host is ${process.platform}; spctl and stapler validate only run on macOS, so nothing was assessed`
    } else {
      const dmgs = (release?.assets ?? [])
        .map((asset) => asset.name)
        .filter((name) => name.includes('-mac-') && name.endsWith('.dmg'))
      installerAssessments = []
      for (const name of dmgs) {
        const work = mkdtempSync(join(tmpdir(), 'purescience-gatekeeper-'))
        try {
          run('gh', [
            'release',
            'download',
            tag,
            '--repo',
            repo,
            '--pattern',
            name,
            '--dir',
            work,
            '--clobber'
          ])
          const file = join(work, name)
          // spawnSync, not the throwing helper: spctl answers "rejected" with exit 3 and that answer is
          // the reading we came for, not an exception to swallow.
          const spctl = spawnSync(
            'spctl',
            ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vvv', file],
            { encoding: 'utf8' }
          )
          const stapler = spawnSync('xcrun', ['stapler', 'validate', file], { encoding: 'utf8' })
          installerAssessments.push({
            asset: name,
            ...parseGatekeeperAssessment({
              spctlStatus: spctl.status,
              spctlStdout: spctl.stdout ?? '',
              spctlStderr: spctl.stderr ?? '',
              staplerStatus: stapler.status,
              staplerStdout: stapler.stdout ?? '',
              staplerStderr: stapler.stderr ?? ''
            })
          })
        } catch (error) {
          installerAssessments.push({
            asset: name,
            verdict: 'unreadable',
            source: null,
            stapled: 'unreadable',
            detail: `could not assess: ${String(error.message).split('\n')[0]}`
          })
        } finally {
          rmSync(work, { recursive: true, force: true })
        }
      }
    }
  }

  const verdict = evaluateRelease({
    tag,
    release,
    assetNames: (release?.assets ?? []).map((asset) => asset.name),
    certification,
    sha256SumsText,
    headSha,
    minBodyBytes,
    allowPrerelease,
    requireSigned,
    requireNotarized,
    installerAssessments,
    gatekeeperSkipReason,
    certificationSkipReason,
    sha256SumsSkipReason
  })

  if (asJson) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  } else {
    for (const c of verdict.checks) {
      const mark = c.ok ? 'OK  ' : c.hardFailure ? 'FAIL' : 'WARN'
      process.stdout.write(`${mark} ${c.name}: ${c.detail}\n`)
    }
    process.stdout.write(
      `${verdict.ok ? 'VERDICT: accepted' : 'VERDICT: rejected'} (${verdict.failures.length} failure(s), ${verdict.warnings.length} warning(s))\n`
    )
  }
  process.exit(verdict.ok ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
