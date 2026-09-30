/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  aggregateEvidence,
  artifactEvidence,
  writePlatformEvidence,
  writeWindowsUpdateEvidence
} from './release-certification-evidence.mjs'

const platforms = ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']

describe('release certification evidence', () => {
  it('hashes only user-facing distributables in stable order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-artifacts-'))
    await writeFile(join(root, 'latest.yml'), 'ignored')
    await writeFile(join(root, 'b.zip'), 'b')
    await writeFile(join(root, 'a.dmg'), 'a')

    await expect(artifactEvidence(root)).resolves.toMatchObject([
      { name: 'a.dmg', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { name: 'b.zip', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
    ])
  })

  it('writes one platform record tied to the workflow run and source SHA', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-write-'))
    const output = join(root, 'certification-linux-x64.json')
    await writeFile(join(root, 'app.AppImage'), 'artifact')

    await writePlatformEvidence({
      argv: [
        '--platform',
        'linux-x64',
        '--artifact-dir',
        root,
        '--output',
        output,
        '--electron-p0',
        'not-applicable',
        '--visual-regression',
        'not-applicable',
        '--package-smoke',
        'passed',
        '--authenticode',
        'not-applicable'
      ],
      environment: {
        GITHUB_REPOSITORY: 'zerolink/purescience',
        GITHUB_REF: 'refs/tags/v0.11.0',
        GITHUB_SHA: 'abc123',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '2'
      }
    })

    await expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
      platform: 'linux-x64',
      source: { sha: 'abc123', runId: '42', runAttempt: '2' },
      checks: {
        electronP0: 'not-applicable',
        visualRegression: 'not-applicable',
        packageSmoke: 'passed'
      }
    })
  })

  it('records every real Windows update-drill phase without claiming code signing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-update-'))
    const output = join(root, 'certification-windows-update.json')
    const updaterObservation = join(root, 'windows-updater-observation.json')
    const environment = {
      GITHUB_SHA: 'abc123',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1'
    }
    await writeFile(
      updaterObservation,
      JSON.stringify({
        schemaVersion: 1,
        mode: 'electron-updater-differential',
        feedRequests: 1,
        blockmapRequests: 2,
        rangeRequests: 3,
        fullInstallerRequests: 0,
        downloadedInstallerBytes: 40,
        installerBytes: 100,
        versionedFeed: true,
        previousInstallerCacheVerified: true,
        previousVersion: '0.10.0',
        currentVersion: '0.11.0'
      })
    )

    await expect(
      writeWindowsUpdateEvidence({
        argv: [
          '--output',
          output,
          '--current-tag',
          'v0.11.0',
          '--previous-tag',
          'v0.10.0',
          '--status',
          'passed',
          '--updater-observation',
          updaterObservation
        ],
        environment
      })
    ).resolves.toMatchObject({
      kind: 'windows-update-drill',
      checks: {
        authenticode: 'not-required',
        electronUpdater: 'passed',
        incrementalDownload: 'passed',
        feedCompatibility: 'passed',
        silentInstall: 'passed',
        processLock: 'passed',
        rollback: 'passed',
        restart: 'passed'
      }
    })
    await expect(
      writeWindowsUpdateEvidence({
        argv: ['--output', output, '--current-tag', 'v0.11.0', '--status', 'passed'],
        environment
      })
    ).rejects.toThrow(/previous stable tag/)
    await expect(
      writeWindowsUpdateEvidence({
        argv: [
          '--output',
          output,
          '--current-tag',
          'v0.11.0',
          '--previous-tag',
          'v0.10.0',
          '--status',
          'passed'
        ],
        environment
      })
    ).rejects.toThrow(/differential updater observation/)
    await expect(
      writeWindowsUpdateEvidence({
        argv: [
          '--output',
          output,
          '--current-tag',
          'v0.12.0',
          '--previous-tag',
          'v0.10.0',
          '--status',
          'passed',
          '--updater-observation',
          updaterObservation
        ],
        environment
      })
    ).rejects.toThrow(/do not match the release tags/)
    // On-demand drill (dispatch, no tag): the differential proof is still recorded, even though there is no
    // release tag for the observed versions to match (issue #14).
    await expect(
      writeWindowsUpdateEvidence({
        argv: [
          '--output',
          output,
          '--current-tag',
          'main',
          '--previous-tag',
          'v0.10.0',
          '--status',
          'passed',
          '--updater-observation',
          updaterObservation
        ],
        environment
      })
    ).resolves.toMatchObject({ kind: 'windows-update-drill', status: 'passed' })
    await expect(
      writeWindowsUpdateEvidence({
        argv: ['--output', output, '--current-tag', 'v0.11.0', '--status', 'not-applicable'],
        environment
      })
    ).rejects.toThrow(/approved reason/)
    await expect(
      writeWindowsUpdateEvidence({
        argv: [
          '--output',
          output,
          '--current-tag',
          'v0.11.0',
          '--previous-tag',
          'v0.10.0',
          '--status',
          'failed',
          '--reason',
          'updater=failure,installer=success'
        ],
        environment
      })
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'updater=failure,installer=success',
      checks: { authenticode: 'not-required', electronUpdater: 'failed' }
    })
  })

  it('fails closed on missing platforms, mismatched SHA, or incomplete stable evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-aggregate-'))
    const output = join(root, 'RELEASE-CERTIFICATION.json')
    const artifactDigest = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
    const recordFor = (platform: string, sha = 'abc123') => ({
      schemaVersion: 1,
      platform,
      source: { sha },
      checks: {
        electronP0: platform === 'macos-arm64' ? 'passed' : 'not-applicable',
        visualRegression: platform === 'macos-arm64' ? 'passed' : 'not-applicable',
        packageSmoke: 'passed',
        authenticode: platform === 'windows-x64' ? 'not-required' : 'not-applicable'
      },
      // The macOS arm of every record states its signing state and the reading behind it (issue #19).
      ...(platform.startsWith('macos-')
        ? {
            macSignature: 'unsigned',
            macSignatureEvidence: {
              credentialsPresent: false,
              teamIdExpected: '87G9WFU9H3',
              identifier: 'com.zerolink.purescience',
              teamIdentifier: 'not set',
              readingSource: 'shipped-zip'
            }
          }
        : {}),
      artifacts: [{ name: `${platform}.zip`, sha256: artifactDigest }]
    })
    for (const platform of platforms.slice(0, -1)) {
      await writeFile(join(root, `${platform}.zip`), 'a')
      await writeFile(
        join(root, `certification-${platform}.json`),
        JSON.stringify(recordFor(platform))
      )
    }
    const args = ['--directory', root, '--output', output, '--expected-sha', 'abc123']
    await expect(aggregateEvidence({ argv: args })).rejects.toThrow(/missing: windows-x64/)

    await writeFile(join(root, 'windows-x64.zip'), 'a')
    await writeFile(
      join(root, 'certification-windows-x64.json'),
      JSON.stringify(recordFor('windows-x64'))
    )
    await expect(aggregateEvidence({ argv: args })).resolves.toMatchObject({
      sourceSha: 'abc123',
      platforms: expect.arrayContaining([expect.objectContaining({ platform: 'windows-x64' })])
    })

    await writeFile(
      join(root, 'certification-windows-x64.json'),
      JSON.stringify({
        ...recordFor('windows-x64'),
        checks: {
          ...recordFor('windows-x64').checks,
          electronP0: 'passed',
          visualRegression: 'passed'
        }
      })
    )
    await expect(aggregateEvidence({ argv: args })).rejects.toThrow(
      /Invalid release certification evidence for windows-x64/
    )
    await writeFile(
      join(root, 'certification-windows-x64.json'),
      JSON.stringify(recordFor('windows-x64'))
    )

    await writeFile(
      join(root, 'certification-macos-arm64.json'),
      JSON.stringify({
        ...recordFor('macos-arm64'),
        checks: { ...recordFor('macos-arm64').checks, packageSmoke: 'not-applicable' }
      })
    )
    await expect(aggregateEvidence({ argv: args })).rejects.toThrow(
      /Package smoke did not pass for macos-arm64/
    )
    await writeFile(
      join(root, 'certification-macos-arm64.json'),
      JSON.stringify(recordFor('macos-arm64'))
    )
    await expect(aggregateEvidence({ argv: args })).resolves.toMatchObject({
      sourceSha: 'abc123',
      platforms: expect.arrayContaining([expect.objectContaining({ platform: 'macos-arm64' })])
    })

    // Visual regression is informational (env-sensitive on CI runners): a macos-arm64 record that
    // honestly reports not-applicable must still aggregate — electronP0 stays the hard gate.
    await writeFile(
      join(root, 'certification-macos-arm64.json'),
      JSON.stringify({
        ...recordFor('macos-arm64'),
        checks: { ...recordFor('macos-arm64').checks, visualRegression: 'not-applicable' }
      })
    )
    await expect(aggregateEvidence({ argv: args })).resolves.toMatchObject({
      sourceSha: 'abc123',
      platforms: expect.arrayContaining([expect.objectContaining({ platform: 'macos-arm64' })])
    })
    await writeFile(
      join(root, 'certification-windows-update.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'windows-update-drill',
        source: { sha: 'abc123' },
        currentTag: 'v0.11.0',
        previousTag: 'v0.10.0',
        status: 'passed',
        checks: {
          authenticode: 'not-required',
          electronUpdater: 'passed',
          incrementalDownload: 'passed',
          feedCompatibility: 'passed',
          silentInstall: 'passed',
          processLock: 'passed',
          rollback: 'passed',
          restart: 'passed'
        },
        updater: {
          schemaVersion: 1,
          mode: 'electron-updater-differential',
          feedRequests: 1,
          blockmapRequests: 2,
          rangeRequests: 3,
          fullInstallerRequests: 0,
          downloadedInstallerBytes: 40,
          installerBytes: 100,
          versionedFeed: true,
          previousInstallerCacheVerified: true,
          previousVersion: '0.10.0',
          currentVersion: '0.11.0'
        }
      })
    )
    await expect(
      aggregateEvidence({
        argv: [...args, '--require-windows-update']
      })
    ).resolves.toMatchObject({
      releaseChecks: {
        windowsUpdate: { status: 'passed' }
      }
    })

    // The macOS signing state travels in the record (issue #19). A mac record that cannot state it,
    // that claims an unproven state, or that contradicts its own credentials input is not publishable;
    // a record that honestly says "unsigned, no credentials configured" is (that is today's reality).
    const macRecord = () => JSON.parse(JSON.stringify(recordFor('macos-arm64')))
    const writeMacRecord = (record: unknown) =>
      writeFile(join(root, 'certification-macos-arm64.json'), JSON.stringify(record))

    const statedNothing = macRecord()
    delete statedNothing.macSignature
    await writeMacRecord(statedNothing)
    await expect(aggregateEvidence({ argv: args })).rejects.toThrow(/must record macSignature/)

    await writeMacRecord({ ...macRecord(), macSignature: 'unproven' })
    await expect(aggregateEvidence({ argv: args })).rejects.toThrow(/records an unproven signature/)

    await writeMacRecord({
      ...macRecord(),
      macSignature: 'unsigned',
      macSignatureEvidence: { ...macRecord().macSignatureEvidence, credentialsPresent: true }
    })
    await expect(aggregateEvidence({ argv: args })).rejects.toThrow(
      /contradicts its signing credentials/
    )

    await writeMacRecord(macRecord())
    await expect(aggregateEvidence({ argv: args })).resolves.toMatchObject({
      platforms: expect.arrayContaining([
        expect.objectContaining({ platform: 'macos-arm64', macSignature: 'unsigned' })
      ])
    })
  })

  it('records the macOS signing state and refuses to write one the signature gate rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-mac-signing-'))
    const output = join(root, 'certification-macos-arm64.json')
    const reading = join(root, 'purescience-mac-signature.json')
    const environment = { GITHUB_SHA: 'abc123', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' }
    const macArguments = (credentials: string, extra: string[] = []) => [
      '--platform',
      'macos-arm64',
      '--artifact-dir',
      root,
      '--output',
      output,
      '--electron-p0',
      'not-applicable',
      '--visual-regression',
      'not-applicable',
      '--package-smoke',
      'passed',
      '--authenticode',
      'not-applicable',
      ...extra,
      '--mac-signing-credentials',
      credentials,
      '--mac-signature-reading',
      reading
    ]
    const readingFor = (teamIdentifier: string) =>
      JSON.stringify({
        schemaVersion: 1,
        source: 'shipped-zip',
        readable: true,
        identifier: 'com.zerolink.purescience',
        teamIdentifier,
        signed: teamIdentifier === '87G9WFU9H3'
      })
    await writeFile(join(root, 'app.zip'), 'artifact')

    // Credentials configured but the shipped bundle is ad-hoc: the record is never written.
    await writeFile(reading, readingFor('not set'))
    await expect(
      writePlatformEvidence({ argv: macArguments('present'), environment })
    ).rejects.toThrow(/macOS signature gate failed for macos-arm64/)
    await expect(readFile(output, 'utf8')).rejects.toThrow()

    // No credentials: recorded as unsigned — reported, never verified.
    await expect(
      writePlatformEvidence({ argv: macArguments('absent'), environment })
    ).resolves.toMatchObject({
      platform: 'macos-arm64',
      macSignature: 'unsigned',
      macSignatureEvidence: {
        credentialsPresent: false,
        teamIdExpected: '87G9WFU9H3',
        teamIdentifier: 'not set',
        readingSource: 'shipped-zip'
      }
    })

    // No credentials AND no reading: unobserved must not become a record (not a pass).
    await rm(reading)
    await expect(
      writePlatformEvidence({ argv: macArguments('absent'), environment })
    ).rejects.toThrow(/macOS signature gate failed for macos-arm64/)

    // Credentials configured and the bundle carries the shipping Developer ID: signed.
    await writeFile(reading, readingFor('87G9WFU9H3'))
    await expect(
      writePlatformEvidence({ argv: macArguments('present'), environment })
    ).resolves.toMatchObject({
      macSignature: 'signed',
      macSignatureEvidence: { credentialsPresent: true, teamIdentifier: '87G9WFU9H3' }
    })

    // macOS evidence without the credentials input is refused by name rather than defaulted.
    await expect(
      writePlatformEvidence({
        argv: [
          '--platform',
          'macos-x64',
          '--artifact-dir',
          root,
          '--output',
          output,
          '--electron-p0',
          'not-applicable',
          '--visual-regression',
          'not-applicable',
          '--package-smoke',
          'passed',
          '--authenticode',
          'not-applicable'
        ],
        environment
      })
    ).rejects.toThrow(/--mac-signing-credentials/)

    // ...and without a reading either.
    await expect(
      writePlatformEvidence({
        argv: [
          '--platform',
          'macos-x64',
          '--artifact-dir',
          root,
          '--output',
          output,
          '--electron-p0',
          'not-applicable',
          '--visual-regression',
          'not-applicable',
          '--package-smoke',
          'passed',
          '--authenticode',
          'not-applicable',
          '--mac-signing-credentials',
          'absent'
        ],
        environment
      })
    ).rejects.toThrow(/--mac-signature-reading/)
  })
})
