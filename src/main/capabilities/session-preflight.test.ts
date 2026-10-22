import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildCapabilityPreflight, type SessionFactSources } from './session-preflight'

let configRoot: string

const writeSkill = async (id: string, contract: string): Promise<void> => {
  const dir = join(configRoot, 'skills', id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: "d"\ncontract: '${contract}'\n---\n\n# ${id}\n`,
    'utf8'
  )
}

const deps = (
  sources: SessionFactSources | null
): { loadFacts: (sessionId: string) => Promise<SessionFactSources | null> } => ({
  loadFacts: async () => sources
})

beforeEach(async () => {
  configRoot = await mkdtemp(join(tmpdir(), 'session-preflight-'))
  await writeSkill(
    'needs-matrix',
    '{"id":"needs-matrix","aliases":["矩阵"],"requires":["input:omics_file"],"produces":["data:summary"]}'
  )
  await writeSkill(
    'makes-summary',
    '{"id":"makes-summary","requires":[],"produces":["data:summary"]}'
  )
})

afterEach(async () => {
  await rm(configRoot, { recursive: true, force: true })
})

describe('buildCapabilityPreflight', () => {
  it('reports ready when the session holds the required fact', async () => {
    const payload = await buildCapabilityPreflight({
      configRoot,
      sessionId: 's1',
      capability: 'needs-matrix',
      deps: deps({
        attachments: [{ name: 'pbmc.h5ad' }],
        artifacts: [],
        referencedCapabilities: []
      })
    })
    expect(payload).toMatchObject({ capability: 'needs-matrix', status: 'ready' })
    expect(payload?.requires).toEqual(['input:omics_file'])
    expect(payload?.facts).toContain('input:omics_file')
  })

  it('names the missing fact and the capability that would establish it', async () => {
    const payload = await buildCapabilityPreflight({
      configRoot,
      sessionId: 's1',
      capability: 'needs-matrix',
      deps: deps({ attachments: [], artifacts: [], referencedCapabilities: [] })
    })
    expect(payload?.status).toBe('missing_state')
    expect(payload?.missing).toEqual([{ fact: 'input:omics_file', producers: [] }])
    expect(payload?.suggested).toEqual([])
  })

  it('suggests a producer when one exists in the same install', async () => {
    await writeSkill(
      'needs-summary',
      '{"id":"needs-summary","requires":["data:summary"],"produces":["review:x"]}'
    )
    const payload = await buildCapabilityPreflight({
      configRoot,
      sessionId: 's1',
      capability: 'needs-summary',
      deps: deps({ attachments: [], artifacts: [], referencedCapabilities: [] })
    })
    expect(payload?.status).toBe('missing_state')
    // Both declared capabilities produce data:summary, so both are legitimate next steps.
    expect(payload?.suggested).toEqual(expect.arrayContaining(['makes-summary', 'needs-matrix']))
  })

  it('names a capability that is not installed at all', async () => {
    const payload = await buildCapabilityPreflight({
      configRoot,
      sessionId: 's1',
      capability: 'not-a-skill',
      deps: deps({ attachments: [], artifacts: [], referencedCapabilities: [] })
    })
    expect(payload).toMatchObject({ status: 'undeclared', reason: 'no_contract' })
    expect(payload?.notes).toContain('unknown_capability')
  })

  it('returns null for an unknown session rather than an empty reading', async () => {
    const payload = await buildCapabilityPreflight({
      configRoot,
      sessionId: 'gone',
      capability: 'needs-matrix',
      deps: deps(null)
    })
    expect(payload).toBeNull()
  })

  it('notes that a referenced skill is a mention, not an execution', async () => {
    const payload = await buildCapabilityPreflight({
      configRoot,
      sessionId: 's1',
      capability: 'needs-matrix',
      deps: deps({
        attachments: [],
        artifacts: [],
        referencedCapabilities: ['makes-summary']
      })
    })
    expect(payload?.notes).toContain('used_capabilities_from_mentions')
    expect(payload?.facts).toContain('data:summary')
  })
})
