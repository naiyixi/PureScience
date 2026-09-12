import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import { COMPUTE_SKILL_DIRECTORY, syncComputeSkillDoc, renderEngineAvailability } from './skill-doc'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sampleHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'scheduler_cluster',
  executionMode: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: {
    ok: true,
    probedAt: '2026-08-01T00:00:00.000Z',
    exitCode: 0,
    errorTail: null
  },
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const writeCanonicalDocument = async (skillsDir: string): Promise<void> => {
  await mkdir(join(skillsDir, COMPUTE_SKILL_DIRECTORY), { recursive: true })
  await writeFile(
    join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'),
    [
      '---',
      'name: remote-compute-ssh',
      'description: Discover and use SSH compute hosts.',
      '---',
      '',
      '## Registered hosts',
      '',
      '<!-- purescience:compute-hosts:start -->',
      'Run `await host.compute.list()` to see all registered hosts.',
      '<!-- purescience:compute-hosts:end -->',
      '',
      '## Compute readiness',
      '',
      '<!-- purescience:compute-readiness:start -->',
      'Follow the ladder before answering a quantitative request.',
      '<!-- purescience:compute-readiness:end -->',
      '',
      '## API reference',
      '',
      'Use `host.compute.create()` to bind a host.'
    ].join('\n'),
    'utf8'
  )
}

describe('syncComputeSkillDoc', () => {
  it('updates the one canonical document with the current host projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-skill-doc-'))
    roots.push(root)
    const skillsDir = join(root, 'skills')
    await writeCanonicalDocument(skillsDir)

    await syncComputeSkillDoc(skillsDir, [sampleHost()])

    const doc = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(doc).toContain('ssh:biowulf')
    expect(doc).toContain('biowulf')
    expect(doc).toContain('connected')
    expect(doc).toContain('## API reference')
    expect(await readdir(skillsDir)).toEqual([COMPUTE_SKILL_DIRECTORY])
  })

  it('replaces stale host data when a host is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-skill-doc-'))
    roots.push(root)
    const skillsDir = join(root, 'skills')
    await writeCanonicalDocument(skillsDir)

    await syncComputeSkillDoc(skillsDir, [sampleHost()])
    await syncComputeSkillDoc(skillsDir, [])

    const doc = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(doc).toContain('no hosts registered yet')
    expect(doc).not.toContain('ssh:biowulf')
  })

  it('projects the readiness ladder and never-compute guidance into the skill document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-skill-doc-'))
    roots.push(root)
    const skillsDir = join(root, 'skills')
    await writeCanonicalDocument(skillsDir)

    await syncComputeSkillDoc(skillsDir, [sampleHost()])

    const doc = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(doc).toContain('Quantitative-result ladder')
    expect(doc).toContain('never invent a number')
    expect(doc).toContain('not computed: <what>')
    expect(doc).toContain('never submit silently')
    expect(doc).toContain('AlphaFold DB')
    expect(doc).toContain('Report provenance for every number')
    expect(doc).not.toContain('Follow the ladder before answering a quantitative request.')
  })

  it('lists GPUs reported by probes and flags when none are available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-skill-doc-'))
    roots.push(root)
    const skillsDir = join(root, 'skills')
    await writeCanonicalDocument(skillsDir)

    const gpuHost = sampleHost({
      providerId: 'ssh:gpu-box',
      displayName: 'gpu-box',
      executionMode: 'slurm',
      probeResult: {
        ok: true,
        probedAt: '2026-08-01T00:00:00.000Z',
        exitCode: 0,
        errorTail: null,
        gpus: [{ type: 'NVIDIA A100-SXM4-80GB', count: 4 }],
        detectedScheduler: 'slurm'
      }
    })
    await syncComputeSkillDoc(skillsDir, [gpuHost])
    const withGpu = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(withGpu).toContain('gpu-box: NVIDIA A100-SXM4-80GB ×4')
    expect(withGpu).toContain('scheduler dispatch (slurm/sbatch): gpu-box')

    await syncComputeSkillDoc(skillsDir, [sampleHost()])
    const noGpu = await readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    expect(noGpu).toContain('none of the registered hosts reported GPUs at probe time')
  })
})

describe('engine availability projection', () => {
  it('lists every catalog engine with its output kind and why it is blocked', () => {
    const block = renderEngineAvailability([])
    expect(block).toContain('Engines available for this project')
    expect(block).toContain('alphafold-db')
    expect(block).toContain('database lookup')
    // A prediction must never be presented as a measurement.
    expect(block).toContain('esmfold')
    expect(block).toContain('PREDICTED (must be labelled, never presented as a measurement)')
    expect(block).toContain('needs user consent')
    expect(block).toContain('not')
    expect(block).toContain('computed: <what> — requires <engine or host>')
  })

  it('only claims a GPU when a probed host actually reported one', () => {
    const withoutGpu = renderEngineAvailability([
      { id: 'h1', displayName: 'host-1', executionMode: 'direct_ssh', probeResult: { ok: true } }
    ] as never)
    // No probed accelerator ⇒ the folding engine is not advertised as available; it needs a
    // consented weight download (or a GPU host).
    expect(withoutGpu).toContain('esmfold')
    expect(withoutGpu).not.toMatch(/esmfold[^\n]*—\s*available/)
    expect(withoutGpu).toContain('needs user consent')

    const withGpu = renderEngineAvailability([
      {
        id: 'h2',
        displayName: 'host-2',
        executionMode: 'slurm',
        probeResult: { ok: true, gpus: [{ type: 'A100', count: 2 }] }
      }
    ] as never)
    expect(withGpu).toContain('available')
  })
})
