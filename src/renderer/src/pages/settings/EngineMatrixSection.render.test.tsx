// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost, ProbeResult } from '../../../../shared/compute'
import { ENGINE_CATALOG } from '../../../../shared/engine-catalog'
import { EngineMatrixSection } from './EngineMatrixSection'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'

let container: HTMLDivElement
let root: Root

// A complete probe record: the matrix reads `probeResult.ok` and `probeResult.gpus`, and a fixture
// that omits the rest of the wire shape stops compiling rather than silently drifting from it.
const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  ok: true,
  probedAt: '2026-10-06T00:00:00.000Z',
  exitCode: 0,
  errorTail: null,
  ...overrides
})

const host = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  executionMode: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const rowFor = (engineId: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(`[data-engine-id="${engineId}"]`)
  if (!row) throw new Error(`no matrix row rendered for ${engineId}`)
  return row
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({ ...createInitialComputeState(), hosts: [], isLoaded: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('engine matrix', () => {
  it('lists every catalog engine with its output kind and license, for a machine with no hosts', () => {
    act(() => {
      root.render(<EngineMatrixSection />)
    })

    expect(container.querySelectorAll('[data-slot="engine-matrix-row"]')).toHaveLength(
      ENGINE_CATALOG.length
    )
    // Experimental vs predicted vs database lookup: the honesty axis must be visible per row.
    expect(rowFor('pdb').textContent).toContain('Experimental measurement')
    expect(rowFor('alphafold-db').textContent).toContain('Database prediction')
    expect(rowFor('esmfold').textContent).toContain('Prediction (not a measurement)')
    // Commercial restriction is stated where it applies, and not where it does not.
    expect(rowFor('rosetta-ddg').textContent).toContain('Commercial use restricted')
    expect(rowFor('pdb').textContent).not.toContain('Commercial use restricted')
  })

  it('renders the ready state with the engine name and no download control', () => {
    act(() => {
      root.render(<EngineMatrixSection />)
    })

    const ready = rowFor('alphafold-db')
    expect(ready.dataset.engineStatus).toBe('ready')
    expect(ready.textContent).toContain('Available')
    expect(ready.textContent).toContain('AlphaFold DB')
    // Zero-weight engine: nothing to download, and no button to press.
    expect(ready.dataset.weightState).toBe('not-needed')
    expect(ready.textContent).toContain('No weight download needed')

    // A control that must refuse every target would be worse than no control: the section renders no
    // button at all while no engine weight has a published checksum.
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('renders the needs-host state for remote-only engines while no host is registered', () => {
    act(() => {
      root.render(<EngineMatrixSection />)
    })

    const remote = rowFor('openmm-fep')
    expect(remote.dataset.engineStatus).toBe('needs-host')
    expect(remote.textContent).toContain('Needs a compute host')
    // The GPU rule has to be on screen next to the matrix it explains.
    expect(container.textContent).toContain(
      'A GPU counts only when a probed host reported one; this machine never claims a GPU it has not proven.'
    )
  })

  it('renders the blocked-by-weights state honestly instead of offering a consent that cannot work', () => {
    act(() => {
      root.render(<EngineMatrixSection />)
    })

    const blocked = rowFor('ddg-cpu-predictor')
    expect(blocked.dataset.engineStatus).toBe('weights-unavailable')
    expect(blocked.dataset.weightState).toBe('unpublished')
    expect(blocked.textContent).toContain('no downloadable weights in this build')
    // The gate's own sentence names the missing checksum and the size that cannot be fetched.
    expect(blocked.textContent).toContain('No published checksum is on file for this build')
    expect(blocked.textContent).toContain('200 MB')
    // "Needs your approval to download" must not appear for an engine no approval can enable.
    expect(blocked.textContent).not.toContain('Needs your approval to download')
  })

  it('flips a GPU engine from needs-host to available once a probed host reports a GPU', () => {
    useComputeStore.setState({
      hosts: [host({ probeResult: probe({ gpus: [{ type: 'A100', count: 2 }] }) })],
      isLoaded: true
    })

    act(() => {
      root.render(<EngineMatrixSection />)
    })

    const remote = rowFor('openmm-fep')
    expect(remote.dataset.engineStatus).toBe('ready')
    expect(remote.textContent).toContain('Available')
    // ESMFold still cannot run: with a GPU host present the availability says ready, but its weights
    // have no published checksum in this build, so the gate keeps it out — the two facts are separate
    // and the matrix must not collapse them into one.
    const esmfold = rowFor('esmfold')
    expect(esmfold.dataset.engineStatus).toBe('weights-unavailable')
    expect(esmfold.textContent).toContain('no downloadable weights in this build')
  })

  it('does not count a host whose probe failed as a compute host', () => {
    useComputeStore.setState({
      hosts: [
        host({
          probeResult: probe({
            ok: false,
            exitCode: 255,
            errorTail: 'ssh: connect to host biowulf port 22: Connection refused'
          })
        })
      ],
      isLoaded: true
    })

    act(() => {
      root.render(<EngineMatrixSection />)
    })

    expect(rowFor('openmm-fep').dataset.engineStatus).toBe('needs-host')
  })
})
