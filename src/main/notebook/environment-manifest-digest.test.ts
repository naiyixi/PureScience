import { describe, expect, it } from 'vitest'

import type { NotebookEnvironmentManifest } from '../../shared/notebook'
import { environmentManifestDigest } from './environment-state-tracker'

// The replay's environment lock compares this digest between the recorded run and the re-run. That check
// has to be able to succeed in an unchanged environment — the manifest carries capture timestamps, so a
// digest over the whole document never could, and a check that can never match is not a check.

const manifestOf = (
  overrides: Partial<NotebookEnvironmentManifest> = {}
): NotebookEnvironmentManifest => ({
  schemaVersion: 1,
  captureKind: 'completed-run',
  capturedAt: '2026-09-17T05:59:17.329Z',
  installedInventory: {
    capturedAt: '2026-09-17T05:59:17.329Z',
    source: 'full-scan',
    validation: 'full-scan'
  },
  kernelKind: 'python',
  environmentName: 'default-python',
  runtimeSource: 'managed',
  runtimeVersion: '3.12.13',
  platform: 'darwin',
  architecture: 'arm64',
  inventorySources: ['kernel-native', 'interpreter-native'],
  packages: [
    {
      name: 'numpy',
      version: '2.1.0',
      versionStatus: 'known',
      ecosystem: 'python',
      evidenceSources: []
    },
    {
      name: 'pandas',
      version: '2.2.3',
      versionStatus: 'known',
      ecosystem: 'python',
      evidenceSources: []
    }
  ],
  complete: true,
  captureStatus: 'complete',
  ...overrides
})

describe('environment manifest digest', () => {
  it('is the same for two captures of one environment', () => {
    const first = manifestOf()
    const second = manifestOf({
      capturedAt: '2026-09-17T06:31:02.100Z',
      installedInventory: {
        capturedAt: '2026-09-17T06:31:02.100Z',
        source: 'cache-reused',
        validation: 'best-effort'
      },
      inventorySources: ['interpreter-native'],
      complete: false,
      captureStatus: 'partial'
    })

    // The timestamps differ by half an hour, exactly as two real runs in one session did; the environment
    // they describe is the same one.
    expect(environmentManifestDigest(second)).toBe(environmentManifestDigest(first))
  })

  it('does not depend on the order the inventory was walked in', () => {
    const first = manifestOf()
    const reversed = manifestOf({ packages: [...manifestOf().packages].reverse() })

    expect(environmentManifestDigest(reversed)).toBe(environmentManifestDigest(first))
  })

  it('changes when a package version changes', () => {
    const changed = manifestOf({
      packages: [
        {
          name: 'numpy',
          version: '2.2.0',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: []
        },
        {
          name: 'pandas',
          version: '2.2.3',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: []
        }
      ]
    })

    expect(environmentManifestDigest(changed)).not.toBe(environmentManifestDigest(manifestOf()))
  })

  it('changes when a package is added', () => {
    const added = manifestOf({
      packages: [
        ...manifestOf().packages,
        {
          name: 'scipy',
          version: '1.14.0',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: []
        }
      ]
    })

    expect(environmentManifestDigest(added)).not.toBe(environmentManifestDigest(manifestOf()))
  })

  it('changes when a capture could only see part of the environment', () => {
    const partial = manifestOf({
      packages: [manifestOf().packages[0]!],
      complete: false,
      captureStatus: 'partial'
    })

    expect(environmentManifestDigest(partial)).not.toBe(environmentManifestDigest(manifestOf()))
  })

  it('changes when the runtime does', () => {
    const other = manifestOf({ runtimeVersion: '3.13.1', environmentName: 'labeled-python' })

    expect(environmentManifestDigest(other)).not.toBe(environmentManifestDigest(manifestOf()))
  })
})
