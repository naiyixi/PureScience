// The three situations this module must never confuse: nothing to run, the engine refused, and the
// caller sent something unusable. Each has its own code, and each is exercised against a real
// directory tree (the availability check reads the filesystem, so a mocked `existsSync` would test
// the mock rather than the check).

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  checkInverseFolding,
  designInverseFolding,
  describeExpectedLayout,
  InverseFoldingError,
  resolveInverseFoldScript,
  resolveInverseFoldingLayout
} from './inverse-folding'

describe('inverse folding', () => {
  let dataRoot: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'invfold-'))
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  const provision = async (): Promise<void> => {
    const layout = resolveInverseFoldingLayout(dataRoot)
    await mkdir(layout.engineSrc, { recursive: true })
    await mkdir(layout.weights, { recursive: true })
    await mkdir(join(dataRoot, 'runtime', 'envs', 'invfold', 'bin'), { recursive: true })
    await writeFile(join(layout.engineSrc, 'protein_mpnn_run.py'), '# engine\n', 'utf8')
    await writeFile(join(layout.weights, 'v_48_020.pt'), 'weights', 'utf8')
    await writeFile(layout.envPython, '#!/bin/sh\n', 'utf8')
  }

  it('finds the wrapper script by walking up, not by counting parent segments', () => {
    // Measured failure that this test exists for: a hard-coded '../../..' resolved to
    // /private/tmp/resources/... under the bundled out/main layout, and the engine was reported as a
    // transport error rather than as a missing script.
    const resolved = resolveInverseFoldScript({ resourcesPath: '/nonexistent', env: {} })
    expect(resolved.endsWith(join('resources', 'engines', 'inverse_fold.py'))).toBe(true)
    expect(existsSync(resolved)).toBe(true)
  })

  it('reports every missing path instead of a single vague failure', () => {
    const layout = resolveInverseFoldingLayout(dataRoot)
    const availability = checkInverseFolding(layout)

    expect(availability.installed).toBe(false)
    expect(availability.missing).toEqual([layout.engineSrc, layout.weights, layout.envPython])
    expect(describeExpectedLayout(layout)).toBe(layout.engineSrc)
  })

  it('is installed once all three pieces exist', async () => {
    await provision()
    const availability = checkInverseFolding(resolveInverseFoldingLayout(dataRoot))
    expect(availability).toMatchObject({ installed: true, missing: [] })
  })

  it('refuses to run when the engine is not provisioned, without invoking the runner', async () => {
    let called = false
    await expect(
      designInverseFolding({
        layout: resolveInverseFoldingLayout(dataRoot),
        scriptPath: join(dataRoot, 'inverse_fold.py'),
        request: { pdbPath: '/tmp/x.pdb' },
        run: async () => {
          called = true
          return { stdout: '', stderr: '', code: 0 }
        }
      })
    ).rejects.toMatchObject({ code: 'engine-not-provisioned' })
    expect(called).toBe(false)
  })

  it('carries the recomputable inputs through from the engine output', async () => {
    await provision()
    const payload = {
      status: 'ok',
      engine: 'proteinmpnn',
      model: 'v_48_020',
      seed: 37,
      temperature: 0.1,
      nativeSequence: 'TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN',
      samples: [
        {
          index: 1,
          sequence: 'TVCCPSKEAKEAYEKCLKDGTPKEECAKKTGCIIIPGSKCPPNYPY',
          score: '0.8519',
          sequenceRecovery: '0.5000'
        }
      ],
      weightsSha256: 'c9cb4a671d79604111231f8dbfc7c590e06f1197453b7a6854ac6661a642f5bd',
      pdbSha256: '42199a30a0701864a2a5cc76cd7f35cc544cd0e65fbcf63e03c166543249b811',
      engineSha256: 'a'.repeat(64)
    }
    const result = await designInverseFolding({
      layout: resolveInverseFoldingLayout(dataRoot),
      scriptPath: join(dataRoot, 'inverse_fold.py'),
      request: { pdbPath: '/tmp/1crn.pdb', num: 1 },
      run: async () => ({ stdout: `noise\n${JSON.stringify(payload)}\n`, stderr: '', code: 0 })
    })

    expect(result).toMatchObject({
      engine: 'proteinmpnn',
      model: 'v_48_020',
      seed: 37,
      temperature: 0.1,
      weightsSha256: payload.weightsSha256,
      pdbSha256: payload.pdbSha256
    })
    expect(result.samples).toHaveLength(1)
    expect(result.nativeSequence).toHaveLength(46)
  })

  it('passes the engine’s own refusal code through instead of flattening it', async () => {
    await provision()
    await expect(
      designInverseFolding({
        layout: resolveInverseFoldingLayout(dataRoot),
        scriptPath: join(dataRoot, 'inverse_fold.py'),
        request: { pdbPath: '/tmp/missing.pdb' },
        run: async () => ({
          stdout: JSON.stringify({
            status: 'error',
            code: 'pdb-unreadable',
            message: 'missing /tmp/x.pdb'
          }),
          stderr: '',
          code: 2
        })
      })
    ).rejects.toThrow(/pdb-unreadable/)
  })

  it('names a non-JSON crash rather than reporting success', async () => {
    await provision()
    await expect(
      designInverseFolding({
        layout: resolveInverseFoldingLayout(dataRoot),
        scriptPath: join(dataRoot, 'inverse_fold.py'),
        request: { pdbPath: '/tmp/1crn.pdb' },
        run: async () => ({ stdout: '', stderr: 'Traceback: boom', code: 1 })
      })
    ).rejects.toMatchObject({ code: 'design-failed' })
  })

  it('rejects an empty path before touching the engine', async () => {
    await provision()
    await expect(
      designInverseFolding({
        layout: resolveInverseFoldingLayout(dataRoot),
        scriptPath: join(dataRoot, 'inverse_fold.py'),
        request: { pdbPath: '  ' },
        run: async () => ({ stdout: '', stderr: '', code: 0 })
      })
    ).rejects.toBeInstanceOf(InverseFoldingError)
  })
})
