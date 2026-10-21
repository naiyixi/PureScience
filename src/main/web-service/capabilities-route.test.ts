import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PersistedArtifact } from '../../shared/session-persistence'
import { buildCapabilitiesPayload } from './capabilities-route'

let configRoot: string

const artifact = (path: string): PersistedArtifact => ({
  id: path,
  kind: 'workspace-file',
  path
})

const writeSkill = async (id: string, contract?: string): Promise<void> => {
  const dir = join(configRoot, 'skills', id)
  await mkdir(dir, { recursive: true })
  const frontmatter = [
    '---',
    `name: ${id}`,
    'description: "test skill"',
    ...(contract ? [`contract: '${contract}'`] : []),
    '---',
    '',
    '# test',
    ''
  ].join('\n')
  await writeFile(join(dir, 'SKILL.md'), frontmatter, 'utf8')
}

beforeEach(async () => {
  configRoot = await mkdtemp(join(tmpdir(), 'capabilities-route-'))
  await writeSkill(
    'reads-matrix',
    '{"id":"reads-matrix","aliases":["读矩阵"],"requires":["input:omics_file"],"produces":["data:summary"]}'
  )
  await writeSkill(
    'checks-figure',
    '{"id":"checks-figure","aliases":["查图"],"requires":["artifact:figure"],"produces":["review:figure"]}'
  )
  await writeSkill('plain-skill')
})

afterEach(async () => {
  await rm(configRoot, { recursive: true, force: true })
})

describe('buildCapabilitiesPayload', () => {
  it('reports declared, undeclared and problems without any session', async () => {
    const payload = await buildCapabilitiesPayload({ configRoot })
    expect(payload.declared.map((entry) => entry.id)).toEqual(['checks-figure', 'reads-matrix'])
    expect(payload.declared.find((entry) => entry.id === 'reads-matrix')?.requires).toEqual([
      'input:omics_file'
    ])
    expect(payload.undeclared).toEqual(['plain-skill'])
    expect(payload.problems).toEqual([])
    expect(payload.session).toBeNull()
  })

  it('says the store is unavailable instead of reporting empty facts', async () => {
    const payload = await buildCapabilitiesPayload({ configRoot, sessionId: 's1' })
    expect(payload.session).toEqual({
      status: 'unavailable',
      reason: 'artifact_store_unavailable'
    })
  })

  it('reads a session and reports readiness per declared capability', async () => {
    const payload = await buildCapabilitiesPayload({
      configRoot,
      sessionId: 's1',
      listArtifacts: async () => [artifact('out/figure.png')]
    })
    expect(payload.session?.status).toBe('read')
    if (payload.session?.status !== 'read') throw new Error('unreachable')
    expect(payload.session.facts).toEqual(['artifact:figure'])
    expect(payload.session.factSources['artifact:figure']).toEqual(['artifact:out/figure.png'])
    const readings = payload.session.readings
    expect(readings.find((entry) => entry.id === 'checks-figure')).toEqual({
      id: 'checks-figure',
      status: 'ready',
      missing: [],
      suggested: []
    })
    // An artifact store says nothing about a matrix the user attached: that requirement stays unmet,
    // and the note above says attachments were not read.
    expect(readings.find((entry) => entry.id === 'reads-matrix')).toEqual({
      id: 'reads-matrix',
      status: 'missing_state',
      missing: [{ fact: 'input:omics_file', producers: [] }],
      suggested: []
    })
    expect(payload.session.notes).toEqual([
      'used_capabilities_not_recorded',
      'attachments_not_read'
    ])
  })

  it('reports a missing requirement with the capability that would establish it', async () => {
    await writeSkill(
      'needs-summary',
      '{"id":"needs-summary","requires":["data:summary"],"produces":["artifact:report"]}'
    )
    const payload = await buildCapabilitiesPayload({
      configRoot,
      sessionId: 's1',
      listArtifacts: async () => [artifact('out/figure.png')]
    })
    if (payload.session?.status !== 'read') throw new Error('unreachable')
    const reading = payload.session.readings.find((entry) => entry.id === 'needs-summary')
    expect(reading).toEqual({
      id: 'needs-summary',
      status: 'missing_state',
      missing: [{ fact: 'data:summary', producers: ['reads-matrix'] }],
      suggested: ['reads-matrix']
    })
    expect(payload.session.facts).toContain('artifact:figure')
  })

  it('treats a blank session id as no session', async () => {
    const payload = await buildCapabilitiesPayload({
      configRoot,
      sessionId: '   ',
      listArtifacts: async () => []
    })
    expect(payload.session).toBeNull()
  })
})
