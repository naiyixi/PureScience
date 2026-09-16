import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { createArtifactReplayOwner, type ArtifactReplayOwnerPorts } from './replay-owner'
import type { ReplayableVersion } from './replay-owner'

const sha256 = (value: string): string =>
  createHash('sha256').update(Buffer.from(value)).digest('hex')

const OUTPUT = 'a\tb\n1\t2\n'

const version = (overrides: Partial<ReplayableVersion> = {}): ReplayableVersion => ({
  projectId: 'project-1',
  appSessionId: 'session-1',
  filename: 'results/out.tsv',
  checksum: sha256(OUTPUT),
  sizeBytes: Buffer.byteLength(OUTPUT),
  reproductionCode: "open('results/out.tsv','w').write('a\\tb\\n1\\t2\\n')",
  origin: 'executed',
  inputs: [
    {
      path: 'data/in.csv',
      fileId: 'file-1',
      versionId: 'input-version-1',
      sha256: sha256('x,y\n1,2\n'),
      sizeBytes: 8
    }
  ],
  environmentManifestChecksum: 'env-abc',
  language: 'python',
  ...overrides
})

const harness = (
  overrides: Partial<ArtifactReplayOwnerPorts> = {},
  item: ReplayableVersion | undefined = version()
): {
  owner: ReturnType<typeof createArtifactReplayOwner>
  ports: ArtifactReplayOwnerPorts
  executeNotebook: ReturnType<typeof vi.fn>
  materializeInputs: ReturnType<typeof vi.fn>
} => {
  const executeNotebook = vi.fn().mockResolvedValue({
    status: 'completed',
    stdout: '',
    stderr: '',
    environmentManifestChecksum: 'env-abc'
  })
  const materializeInputs = vi.fn().mockResolvedValue(undefined)
  const ports: ArtifactReplayOwnerPorts = {
    readVersion: vi.fn().mockResolvedValue(item),
    materializeInputs,
    createWorkspace: vi.fn().mockResolvedValue('/tmp/replay-ws'),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    readFileBase64: vi.fn().mockResolvedValue(Buffer.from(OUTPUT).toString('base64')),
    digest: (base64: string) => sha256(Buffer.from(base64, 'base64').toString('utf8')),
    executeNotebook,
    appVersion: () => '1.61.0',
    ...overrides
  }
  return {
    owner: createArtifactReplayOwner(ports),
    ports,
    executeNotebook: ports.executeNotebook as ReturnType<typeof vi.fn>,
    materializeInputs: ports.materializeInputs as ReturnType<typeof vi.fn>
  }
}

const request = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1'
}

describe('artifact replay owner', () => {
  it('re-runs the recorded code with the recorded inputs and reproduces the recorded bytes', async () => {
    const { owner, executeNotebook, materializeInputs } = harness()
    const outcome = await owner.replayVersion(request)

    expect(outcome.report.verdict).toBe('reproduced')
    // The recorded inputs are the ones handed to the workspace, addressed by the ids the record carries.
    expect(materializeInputs).toHaveBeenCalledWith('/tmp/replay-ws', [
      expect.objectContaining({
        path: 'data/in.csv',
        fileId: 'file-1',
        versionId: 'input-version-1'
      })
    ])
    expect(executeNotebook).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        workspaceCwd: '/tmp/replay-ws',
        code: version().reproductionCode,
        language: 'python'
      })
    )
  })

  // The environment claim is the one most easily overstated: it is only "applied" when the re-run's own
  // manifest matches the recorded one, and never when either side is missing or different.
  it('reports the environment lock only when the re-run’s manifest matches the recorded one', async () => {
    const matching = await harness().owner.replayVersion(request)
    expect(matching.environmentLock).toBe('applied')

    const differing = await harness({
      executeNotebook: vi.fn().mockResolvedValue({
        status: 'completed',
        stdout: '',
        stderr: '',
        environmentManifestChecksum: 'env-other'
      })
    }).owner.replayVersion(request)
    expect(differing.environmentLock).toBe('not-applied')
    expect(differing.report.verdict).toBe('reproduced')

    const missing = await harness({
      executeNotebook: vi.fn().mockResolvedValue({ status: 'completed', stdout: '', stderr: '' })
    }).owner.replayVersion(request)
    expect(missing.environmentLock).toBe('not-applied')
  })

  // No recorded code is not "reproduction failed": it is "there is nothing to run", and it is said so.
  it('refuses to re-run a version that recorded no code, without running anything', async () => {
    const { owner, executeNotebook } = harness({}, version({ reproductionCode: undefined }))
    const outcome = await owner.replayVersion(request)

    expect(executeNotebook).not.toHaveBeenCalled()
    expect(outcome.stopped).toBe('no-recorded-code')
    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('recorded no code')
  })

  it('never executes a version whose steps were inferred rather than recorded', async () => {
    const { owner, executeNotebook } = harness({}, version({ origin: 'reconstructed' }))
    const outcome = await owner.replayVersion(request)

    expect(executeNotebook).not.toHaveBeenCalled()
    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons.join(' ')).toContain('model reconstruction')
  })

  it('reports an unreadable version as unverifiable rather than as a failed reproduction', async () => {
    // An explicit `undefined` argument would fall back to the default fixture, so the absence is an
    // override here — the difference between "no version" and "the usual version" has to be real.
    const { owner, executeNotebook } = harness({
      readVersion: vi.fn().mockResolvedValue(undefined)
    })
    const outcome = await owner.replayVersion(request)

    expect(executeNotebook).not.toHaveBeenCalled()
    expect(outcome.stopped).toBe('version-unreadable')
    expect(outcome.report.verdict).toBe('unverifiable')
  })

  it('reports a runtime that is not available instead of a difference', async () => {
    const { owner } = harness({
      executeNotebook: vi
        .fn()
        .mockResolvedValue({ status: 'unavailable', reason: 'no python runtime installed' })
    })
    const outcome = await owner.replayVersion(request)

    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('no python runtime')
  })

  it('turns a failing kernel run into an unverifiable outcome, keeping the traceback', async () => {
    const { owner } = harness({
      executeNotebook: vi.fn().mockResolvedValue({
        status: 'failed',
        stdout: '',
        stderr: '',
        traceback: 'ModuleNotFoundError: No module named pandas'
      })
    })
    const outcome = await owner.replayVersion(request)

    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('No module named pandas')
  })

  it('reports a different result as differing, with the recorded digest against the found one', async () => {
    const { owner } = harness({
      readFileBase64: vi.fn().mockResolvedValue(Buffer.from('a\tb\n1\t9\n').toString('base64'))
    })
    const outcome = await owner.replayVersion(request)

    expect(outcome.report.verdict).toBe('differs')
    expect(outcome.report.files[0]).toMatchObject({ status: 'differs' })
  })

  it('removes the workspace it created', async () => {
    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    const { owner } = harness({ removeWorkspace })
    await owner.replayVersion(request)

    expect(removeWorkspace).toHaveBeenCalledWith('/tmp/replay-ws')
  })
})
