// Molecular dynamics has fewer moving parts than inverse folding (one binary, no weights) but the same
// three situations must stay separate: nothing to run, the engine refused, the caller sent nonsense.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  checkMolecularDynamics,
  resolveMolecularDynamicsLayout,
  resolveMolecularDynamicsScript,
  runMolecularDynamics
} from './molecular-dynamics'

describe('molecular dynamics', () => {
  let dataRoot: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'md-'))
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  const provision = async (): Promise<void> => {
    const layout = resolveMolecularDynamicsLayout(dataRoot)
    await mkdir(join(dataRoot, 'runtime', 'envs', 'md', 'bin'), { recursive: true })
    await writeFile(layout.gmx, '#!/bin/sh\n', 'utf8')
  }

  it('names the binary path when the environment is absent', () => {
    const layout = resolveMolecularDynamicsLayout(dataRoot)
    expect(checkMolecularDynamics(layout)).toMatchObject({
      installed: false,
      missing: [layout.gmx]
    })
  })

  it('is installed once the binary exists', async () => {
    await provision()
    expect(checkMolecularDynamics(resolveMolecularDynamicsLayout(dataRoot))).toMatchObject({
      installed: true,
      missing: []
    })
  })

  it('refuses without invoking the runner when nothing is provisioned', async () => {
    let called = false
    await expect(
      runMolecularDynamics({
        layout: resolveMolecularDynamicsLayout(dataRoot),
        scriptPath: join(dataRoot, 'md.py'),
        python: 'python3',
        outDir: join(dataRoot, 'out'),
        request: { pdbPath: '/tmp/1crn.pdb' },
        run: async () => {
          called = true
          return { stdout: '', stderr: '', code: 0 }
        }
      })
    ).rejects.toMatchObject({ code: 'engine-not-provisioned' })
    expect(called).toBe(false)
  })

  it('carries the honest reproducibility verdict through instead of flattening it', async () => {
    await provision()
    const payload = {
      status: 'ok',
      engine: 'gromacs',
      engineVersion: 'GROMACS - gmx, 2025.4-conda_forge',
      pdbSha256: '42199a30a0701864a2a5cc76cd7f35cc544cd0e65fbcf63e03c166543249b811',
      steps: 5000,
      temperature: 300,
      seed: 37,
      solvent: 'vacuum',
      forceField: 'amber99sb-ildn',
      waterModel: 'tip3p',
      frames: 11,
      atoms: 642,
      finalStructure: { sha256: 'a'.repeat(64), bytes: 44343 },
      trajectory: { sha256: 'b'.repeat(64), bytes: 27548 },
      statistics: { meanTemperature: 303.0435, meanPotential: -2859.6023 },
      reproducible: {
        inputFingerprint: true,
        byteIdenticalOutput: false,
        note: 'measured'
      }
    }
    const result = await runMolecularDynamics({
      layout: resolveMolecularDynamicsLayout(dataRoot),
      scriptPath: join(dataRoot, 'md.py'),
      python: 'python3',
      outDir: join(dataRoot, 'out'),
      request: { pdbPath: '/tmp/1crn.pdb' },
      run: async () => ({ stdout: `noise\n${JSON.stringify(payload)}\n`, stderr: '', code: 0 })
    })

    expect(result).toMatchObject({ frames: 11, atoms: 642, solvent: 'vacuum' })
    // The verdict must survive the round trip: a layer that "helpfully" set this true would turn a
    // measured property of the engine into a claim the app cannot support.
    expect(result.reproducible.byteIdenticalOutput).toBe(false)
    expect(result.reproducible.inputFingerprint).toBe(true)
  })

  it('passes the engine’s own refusal code through', async () => {
    await provision()
    await expect(
      runMolecularDynamics({
        layout: resolveMolecularDynamicsLayout(dataRoot),
        scriptPath: join(dataRoot, 'md.py'),
        python: 'python3',
        outDir: join(dataRoot, 'out'),
        request: { pdbPath: '/tmp/1crn.pdb' },
        run: async () => ({
          stdout: JSON.stringify({
            status: 'error',
            code: 'topology-failed',
            message: 'unknown residue'
          }),
          stderr: '',
          code: 2
        })
      })
    ).rejects.toThrow(/topology-failed/)
  })

  it('finds the wrapper script by walking up', () => {
    const resolved = resolveMolecularDynamicsScript({ resourcesPath: '/nonexistent', env: {} })
    expect(resolved.endsWith(join('resources', 'engines', 'md.py'))).toBe(true)
  })
})
