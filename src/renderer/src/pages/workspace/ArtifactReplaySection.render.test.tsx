// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactReplaySection } from './ArtifactReplaySection'
import type { ReplayVersionResult } from '../../../../shared/artifact-replay'

let container: HTMLDivElement
let root: Root
const replayVersion = vi.fn()

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(
      <ArtifactReplaySection
        projectId="project-1"
        appSessionId="session-1"
        artifactId="artifact-1"
        versionId="version-2"
      />
    )
  })
}

const run = async (): Promise<void> => {
  await act(async () => {
    container
      .querySelector('[data-testid="artifact-replay-run"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

const result: ReplayVersionResult = {
  report: {
    mode: 're-run',
    verdict: 'differs',
    origin: 'executed',
    reasons: ['app-version-mismatch:recorded-1.2.3'],
    files: [
      { path: 'out/alpha.txt', status: 'match' },
      {
        path: 'out/beta.txt',
        status: 'differs',
        firstDifferingByte: 7,
        originalBytes: 10,
        replayBytes: 12
      },
      { path: 'out/gamma.h5', status: 'not-comparable', reason: 'size-beyond-comparison-bound' }
    ]
  },
  environmentLock: 'applied',
  execution: { via: 'micromamba', exitCode: 0, timedOut: false, durationMs: 1234, stderrTail: '' },
  environmentManifestChecksum: 'abc123'
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ;(window as unknown as { api: unknown }).api = { artifacts: { replayVersion } }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  replayVersion.mockReset()
})

describe('ArtifactReplaySection', () => {
  it('replays the named version and lays the whole result out', async () => {
    replayVersion.mockResolvedValue(result)
    await render()
    await run()

    expect(replayVersion).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-2'
    })
    const text = container.textContent ?? ''
    // Mode and verdict are separate claims and both are stated.
    expect(
      container.querySelector('[data-testid="artifact-replay-verdict"]')?.textContent
    ).toContain('Differs: the re-run does not match the record.')
    expect(text).toContain('Re-run: a fresh execution')
    expect(text).toContain('recorded from an execution')
    // The environment lock and the manifest it produced are their own line, not folded into the verdict.
    const environment = container.querySelector('[data-testid="artifact-replay-environment"]')
    expect(environment?.textContent).toContain('The environment lock was applied.')
    expect(environment?.textContent).toContain('manifest abc123')
    expect(
      container.querySelector('[data-testid="artifact-replay-execution"]')?.textContent
    ).toContain('via micromamba · exit 0 · 1234 ms')
    // Per-file verdicts keep the numbers they named.
    const files =
      container.querySelector('[data-testid="artifact-replay-files"]')?.textContent ?? ''
    expect(files).toContain('out/alpha.txt')
    expect(files).toContain('matches')
    expect(files).toContain('differs at byte 7 (recorded 10, replay 12)')
    expect(files).toContain('too large for a byte comparison')
    expect(
      container.querySelector('[data-testid="artifact-replay-reasons"]')?.textContent
    ).toContain('app-version-mismatch:recorded-1.2.3')
  })

  it('names why a replay stopped instead of dressing it up as a verdict', async () => {
    replayVersion.mockResolvedValue({ stopped: 'no-recorded-code' })
    await render()
    await run()

    expect(container.querySelector('[data-testid="artifact-replay-stopped"]')?.textContent).toBe(
      'Nothing was recorded to re-run.'
    )
    expect(container.querySelector('[data-testid="artifact-replay-verdict"]')).toBeNull()
  })

  it('reports a replay that could not be run at all', async () => {
    replayVersion.mockRejectedValue(new Error('Artifact replay is not configured.'))
    await render()
    await run()

    expect(container.querySelector('[data-testid="artifact-replay-failure"]')?.textContent).toBe(
      'Artifact replay is not configured.'
    )
    expect(container.querySelector('[data-testid="artifact-replay-verdict"]')).toBeNull()
  })
})
