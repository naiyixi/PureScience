import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  assertDifferentialObservation,
  assertInstallerCachePurged,
  buildLocalUpdaterConfig,
  parseArguments,
  parseSingleRange,
  rewriteFeedPaths
} from './windows-updater-certification.mjs'

describe('Windows updater certification', () => {
  it('points the installed updater at a local feed without weakening its signing policy', () => {
    const result = buildLocalUpdaterConfig(
      'provider: generic\nurl: https://example.test\nupdaterCacheDirName: app-updater\npublisherName: Old Signer\n',
      'http://127.0.0.1:4321'
    )

    expect(result.updaterCacheDirName).toBe('app-updater')
    expect(load(result.source)).toMatchObject({
      provider: 'generic',
      url: 'http://127.0.0.1:4321',
      channel: 'latest',
      useMultipleRangeRequest: false
    })
    expect(load(result.source)).toHaveProperty('publisherName', 'Old Signer')
  })

  it('accepts one bounded HTTP range and rejects multipart ranges', () => {
    expect(parseSingleRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseSingleRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseSingleRange('bytes=100-', 100)).toBeUndefined()
    expect(() => parseSingleRange('bytes=0-1,4-5', 100)).toThrow(/Unsupported HTTP range/)
  })

  it('models the production versioned feed used for skipped-version blockmap lookup', () => {
    expect(
      rewriteFeedPaths(
        'path: purescience-0.11.0-win-x64-setup.exe\nfiles:\n  - url: purescience-0.11.0-win-x64-setup.exe\n',
        '0.11.0'
      )
    ).toBe(
      'path: releases/0.11.0/purescience-0.11.0-win-x64-setup.exe\nfiles:\n  - url: releases/0.11.0/purescience-0.11.0-win-x64-setup.exe\n'
    )
  })

  it('fails when electron-updater falls back to a complete installer download', () => {
    const observation = {
      feedRequests: 1,
      blockmapRequests: 2,
      rangeRequests: 2,
      fullInstallerRequests: 0,
      downloadedInstallerBytes: 40,
      installerBytes: 100,
      versionedFeed: true,
      previousInstallerCacheVerified: true,
      installerCachePurged: true,
      installerCacheBytesBefore: 150_000_000,
      installerCacheBytesAfter: 0,
      previousVersion: '0.10.0',
      currentVersion: '0.11.0'
    }
    expect(assertDifferentialObservation(observation)).toBe(observation)
    expect(() =>
      assertDifferentialObservation({ ...observation, fullInstallerRequests: 1 })
    ).toThrow(/complete differential path/)
    expect(() =>
      assertDifferentialObservation({ ...observation, downloadedInstallerBytes: 100 })
    ).toThrow(/complete differential path/)
  })

  // U3 (#17): the certification also owns "the package is gone once it is installed" — a run that
  // leaves the downloaded installer in the cache is a red run, not a silent 150 MB of residue.
  it('fails when the downloaded installer survives the install', () => {
    const observation = {
      feedRequests: 1,
      blockmapRequests: 2,
      rangeRequests: 2,
      fullInstallerRequests: 0,
      downloadedInstallerBytes: 40,
      installerBytes: 100,
      versionedFeed: true,
      previousInstallerCacheVerified: true,
      installerCachePurged: true,
      installerCacheBytesBefore: 150_000_000,
      installerCacheBytesAfter: 0,
      previousVersion: '0.10.0',
      currentVersion: '0.11.0'
    }
    expect(assertInstallerCachePurged(observation)).toBe(observation)
    expect(() =>
      assertInstallerCachePurged({
        ...observation,
        installerCachePurged: false,
        installerCacheBytesAfter: 150_000_000
      })
    ).toThrow(/did not purge the package it was installed from/)
    expect(() =>
      assertInstallerCachePurged({ ...observation, installerCacheBytesBefore: 0 })
    ).toThrow(/did not purge the package it was installed from/)
    expect(() =>
      assertInstallerCachePurged({ ...observation, installerCacheBytesAfter: 1 })
    ).toThrow(/did not purge the package it was installed from/)
    // A post-install observation that never recorded the three fields is a failure, not a silent pass.
    for (const key of [
      'installerCachePurged',
      'installerCacheBytesBefore',
      'installerCacheBytesAfter'
    ]) {
      expect(() => assertInstallerCachePurged({ ...observation, [key]: undefined })).toThrow(
        /did not purge the package it was installed from/
      )
    }
  })

  // Regression (#17): `assertDifferentialObservation` runs at the top of the run, *before* the version
  // wait, on an observation that cannot carry the installer-cache fields yet — they are only written
  // after the install. Folding those three conditions into this gate turned every run red on a correct
  // differential path (job 109766168273).
  it('accepts the early observation that omits the post-install installer-cache fields', () => {
    const earlyObservation = {
      schemaVersion: 1,
      mode: 'electron-updater-differential',
      previousVersion: '0.10.0',
      currentVersion: '0.11.0',
      installerBytes: 100,
      feedRequests: 33,
      blockmapRequests: 2,
      rangeRequests: 33,
      fullInstallerRequests: 0,
      downloadedInstallerBytes: 40,
      versionedFeed: true,
      previousInstallerCacheVerified: true
    }

    expect(assertDifferentialObservation(earlyObservation)).toBe(earlyObservation)
    // The same payload is *not* purgeable evidence — which is exactly why the early call site cannot be
    // the one that checks the cache.
    expect(() => assertInstallerCachePurged(earlyObservation)).toThrow(
      /did not purge the package it was installed from/
    )
    // The early call site still has to fail fast on a path that never was differential: dropping the
    // purge conditions must not have turned it into a no-op.
    expect(() =>
      assertDifferentialObservation({ ...earlyObservation, fullInstallerRequests: 1 })
    ).toThrow(/complete differential path/)
    expect(() => assertDifferentialObservation({ ...earlyObservation, rangeRequests: 0 })).toThrow(
      /complete differential path/
    )
    expect(() =>
      assertDifferentialObservation({ ...earlyObservation, previousInstallerCacheVerified: false })
    ).toThrow(/complete differential path/)
    expect(() =>
      assertDifferentialObservation({ ...earlyObservation, currentVersion: '0.10.0' })
    ).toThrow(/complete differential path/)
  })

  it('requires both release artifact directories and an evidence output', () => {
    expect(
      parseArguments([
        '--current-dir',
        'current',
        '--previous-dir',
        'previous',
        '--output',
        'observation.json'
      ])
    ).toMatchObject({
      currentDirectory: expect.stringContaining('current'),
      previousDirectory: expect.stringContaining('previous'),
      output: expect.stringContaining('observation.json')
    })
    expect(() => parseArguments(['--current-dir', 'current'])).toThrow(/Usage/)
  })
})
