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
    // Connector-declared contracts share the payload: they are where most facts are established, and
    // this is the one place a caller can see the whole vocabulary at once.
    expect(payload.declared.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['checks-figure', 'reads-matrix', 'search_preprints'])
    )
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
    // Without session records this route cannot see attachments, so that requirement stays unmet and
    // the gap is named rather than filled in.
    expect(readings.find((entry) => entry.id === 'reads-matrix')).toEqual({
      id: 'reads-matrix',
      status: 'missing_state',
      missing: [{ fact: 'input:omics_file', producers: [] }],
      suggested: []
    })
    expect(payload.session.notes).toEqual(['session_inputs_unavailable'])
  })

  it('uses attachments and named skills from the session record', async () => {
    const payload = await buildCapabilitiesPayload({
      configRoot,
      sessionId: 's1',
      listArtifacts: async () => [artifact('out/figure.png')],
      loadSession: async () => ({
        found: true,
        attachments: [{ name: 'pbmc.h5ad' }],
        usedCapabilities: ['reads-matrix']
      })
    })
    if (payload.session?.status !== 'read') throw new Error('unreachable')
    // Order is "attachments, then what the session's capabilities produced, then artifacts" — the
    // order the three sources are composed in, so a reader can tell where each fact came from.
    expect(payload.session.facts).toEqual(['input:omics_file', 'data:summary', 'artifact:figure'])
    expect(payload.session.factSources['input:omics_file']).toEqual(['file:pbmc.h5ad'])
    expect(payload.session.factSources['data:summary']).toEqual(['capability:reads-matrix'])
    expect(payload.session.readings.find((entry) => entry.id === 'reads-matrix')?.status).toBe(
      'ready'
    )
    // A skill the message mentions is not proof it ran; the payload says which one it is.
    expect(payload.session.notes).toEqual(['used_capabilities_from_mentions'])
  })

  it('says the session was not found instead of reporting empty facts', async () => {
    const payload = await buildCapabilitiesPayload({
      configRoot,
      sessionId: 'gone',
      listArtifacts: async () => [],
      loadSession: async () => ({ found: false, attachments: [], usedCapabilities: [] })
    })
    expect(payload.session).toEqual({ status: 'unavailable', reason: 'session_not_found' })
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
    // The same gap, phrased for a prompt: this is what a turn would carry, so it must name the
    // capability, the fact and the producer without anyone having to ask the tool.
    expect(payload.session.promptBlock).toContain('needs-summary 需要 summary（data:summary）')
    expect(payload.session.promptBlock).toContain('reads-matrix')
  })

  it('answers a missing prerequisite with missing_state, never with an exception', async () => {
    // Machine check ①: with the input absent, the reading must be a state — not a traceback and not an
    // empty promise. A throw here would reach the agent as a stack and teach it nothing.
    const payload = await buildCapabilitiesPayload({
      configRoot,
      sessionId: 's-empty',
      listArtifacts: async () => [],
      loadSession: async () => ({ found: true, attachments: [], usedCapabilities: [] })
    })
    if (payload.session?.status !== 'read') throw new Error('expected a readable session')

    const readsMatrix = payload.session.readings.find((entry) => entry.id === 'reads-matrix')
    expect(readsMatrix?.status).toBe('missing_state')
    expect(readsMatrix?.missing.map((entry) => entry.fact)).toContain('input:omics_file')
    // And the whole payload survives serialisation: an exception object would not.
    const wire = JSON.stringify(payload)
    expect(wire).not.toContain('stack')
    expect(wire).not.toContain('traceback')
    expect(JSON.parse(wire)).toMatchObject({ session: { status: 'read' } })
  })

  it('reports a malformed contract as a named problem instead of failing the scan', async () => {
    await writeSkill('broken-skill', '{"id":"broken-skill","produces":["model:thing"]}')

    const payload = await buildCapabilitiesPayload({ configRoot })

    expect(payload.problems).toContain('broken-skill: produces_invalid_fact:model:thing')
    // One bad skill must not hide the healthy ones.
    expect(payload.declared.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['reads-matrix'])
    )
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
