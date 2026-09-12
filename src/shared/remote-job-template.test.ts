import { describe, expect, it } from 'vitest'

import { buildEngineJobTemplate } from './remote-job-template'

describe('remote engine job template', () => {
  it('builds a slurm script with provenance, label reminders and approval wording', () => {
    const template = buildEngineJobTemplate({
      engineId: 'openmm-fep',
      host: { name: 'gpu-a', executionMode: 'slurm', gpus: [{ type: 'A100', count: 4 }] },
      command: 'python run_fep.py --replicas 5',
      resources: { partition: 'gpu', cpus: 8, memoryGb: 32, gpus: 1, walltime: '48:00:00' }
    })

    expect(template.status).toBe('ok')
    if (template.status !== 'ok') return
    expect(template.requiresApproval).toBe(true)
    expect(template.script).toContain('#SBATCH --gres=gpu:1')
    expect(template.script).toContain('#SBATCH --time=48:00:00')
    expect(template.script).toContain('# Engine: openmm-fep')
    expect(template.script).toContain('must be reviewed and approved')
    expect(template.script).toContain('python run_fep.py --replicas 5')
    expect(template.requiredResultLabels.join(' ')).toContain('引擎与版本')
  })

  it('warns about a commercial-restricted licence instead of hiding it', () => {
    const template = buildEngineJobTemplate({
      engineId: 'rosetta-ddg',
      host: { name: 'cpu-node', executionMode: 'direct_ssh' },
      command: './ddg_monomer.linuxgccrelease @flags'
    })
    expect(template.status).toBe('ok')
    if (template.status !== 'ok') return
    expect(template.warnings.join(' ')).toContain('商用受限')
    expect(template.script).toContain('commercial use restricted')
  })

  it('flags a predicted engine and a GPU-less host', () => {
    const template = buildEngineJobTemplate({
      engineId: 'esmfold',
      host: { name: 'gpu-a', executionMode: 'direct_ssh' },
      command: 'python fold.py --seq seq.fa'
    })
    expect(template.status).toBe('ok')
    if (template.status !== 'ok') return
    expect(template.warnings.join(' ')).toContain('预测值')
    expect(template.warnings.join(' ')).toContain('需要 GPU')
    expect(template.warnings.join(' ')).toContain('按需下载')
  })

  it('refuses an unknown engine and lists what exists', () => {
    const template = buildEngineJobTemplate({
      engineId: 'alphafold2-local',
      host: { name: 'h', executionMode: 'direct_ssh' },
      command: 'run'
    })
    expect(template.status).toBe('unknown-engine')
    if (template.status !== 'unknown-engine') return
    expect(template.message).toContain('未知引擎')
    expect(template.message).toContain('alphafold-db')
  })

  it('does not warn about GPU when the host probe reported accelerators', () => {
    const template = buildEngineJobTemplate({
      engineId: 'colabfold',
      host: { name: 'gpu-b', executionMode: 'slurm', gpus: [{ type: 'V100', count: 2 }] },
      command: 'colabfold_batch in out'
    })
    expect(template.status).toBe('ok')
    if (template.status !== 'ok') return
    expect(template.warnings.join(' ')).not.toContain('未报告加速器')
    expect(template.warnings.join(' ')).toContain('多序列比对')
  })
})
