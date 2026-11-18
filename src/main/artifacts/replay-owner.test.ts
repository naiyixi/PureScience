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
  environmentFingerprint: 'fingerprint-abc',
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
    environmentManifestChecksum: 'env-abc',
    environmentFingerprint: 'fingerprint-abc'
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

  // The environment claim is the one most easily overstated, so it is five named outcomes rather than a
  // boolean: `matched` needs a digest on BOTH sides and needs them equal; a digest on one side only is
  // "could not compare" and names which side; a version that recorded none never reads as drift.
  // It is decided on the environment digest — the recorded manifest checksum addresses a stored document
  // and carries its capture timestamps, so it can never match between two runs and is deliberately unused.
  it('claims a matching environment only when both sides digest alike', async () => {
    const matching = await harness().owner.replayVersion(request)
    expect(matching.environment).toBe('matched')

    const differing = await harness({
      executeNotebook: vi.fn().mockResolvedValue({
        status: 'completed',
        stdout: '',
        stderr: '',
        environmentManifestChecksum: 'env-other',
        environmentFingerprint: 'fingerprint-other'
      })
    }).owner.replayVersion(request)
    expect(differing.environment).toBe('drifted')
    // A drifted environment is disclosed, not graded: the bytes still reproduced, and the report keeps the
    // two claims apart instead of turning one into the other.
    expect(differing.report.verdict).toBe('reproduced')

    // A matching stored checksum is not a matching environment, and it must not be read as one.
    const checksumOnly = await harness({
      executeNotebook: vi.fn().mockResolvedValue({
        status: 'completed',
        stdout: '',
        stderr: '',
        environmentManifestChecksum: 'env-abc'
      })
    }).owner.replayVersion(request)
    expect(checksumOnly.environment).toBe('not-reported')

    const missing = await harness({
      executeNotebook: vi.fn().mockResolvedValue({ status: 'completed', stdout: '', stderr: '' })
    }).owner.replayVersion(request)
    expect(missing.environment).toBe('not-reported')
  })

  // An absent digest on either side is "could not compare", kept apart from "the environments differed",
  // and the outcome says which side was missing so a reader is never told more than was checked.
  it('names which side made the environment comparison impossible', async () => {
    const recordedMissing = await harness(
      {},
      version({ environmentFingerprint: undefined })
    ).owner.replayVersion(request)

    expect(recordedMissing.environment).toBe('not-recorded')
    expect(recordedMissing.report.verdict).toBe('reproduced')

    const replayMissing = await harness({
      executeNotebook: vi.fn().mockResolvedValue({ status: 'completed', stdout: '', stderr: '' })
    }).owner.replayVersion(request)
    expect(replayMissing.environment).toBe('not-reported')
  })

  // No recorded code is not "reproduction failed": it is "there is nothing to run", and it is said so.
  it('refuses to re-run a version that recorded no code, without running anything', async () => {
    const { owner, executeNotebook } = harness({}, version({ reproductionCode: undefined }))
    const outcome = await owner.replayVersion(request)

    expect(executeNotebook).not.toHaveBeenCalled()
    expect(outcome.stopped).toBe('no-recorded-code')
    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('recorded no code')
    // Nothing ran, so nothing is claimed about the environment — not even "it could not be compared".
    expect(outcome.environment).toBe('not-run')
  })

  it('never executes a version whose steps were inferred rather than recorded', async () => {
    const { owner, executeNotebook } = harness({}, version({ origin: 'reconstructed' }))
    const outcome = await owner.replayVersion(request)

    expect(executeNotebook).not.toHaveBeenCalled()
    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons.join(' ')).toContain('model reconstruction')
    expect(outcome.environment).toBe('not-run')
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
