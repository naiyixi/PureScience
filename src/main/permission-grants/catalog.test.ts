import { describe, expect, it, vi } from 'vitest'

import { projectPermissionGrantSnapshot } from './catalog'
import type { PermissionGrantRecord } from '../../shared/permission-grants'

describe('permission grant renderer projection', () => {
  it('uses owner names and never exposes an exact qualifier digest', () => {
    const digest = `sha256:v1:${'a'.repeat(64)}`
    const snapshot = projectPermissionGrantSnapshot(
      [
        {
          id: 'grant-1',
          revision: 1,
          capability: {
            kind: 'execution',
            key: 'exec:agent/shell',
            qualifier: { mode: 'exact', value: digest }
          },
          scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
        }
      ],
      {
        projects: new Map([['project-1', 'Research project']]),
        sessions: new Map([['session-1', 'Analyze samples']])
      }
    )

    expect(snapshot).toMatchObject({
      counts: { all: 1, global: 0, project: 0, session: 1 },
      grants: [
        {
          capabilityLabel: 'Shell',
          qualifierLabel: 'Specific input',
          scopeLabel: 'Session: Analyze samples'
        }
      ]
    })
    expect(JSON.stringify(snapshot)).not.toContain(digest)
  })

  it('labels a command group without exposing its qualifier digest', () => {
    const digest = `argv-prefix:sha256:v1:${'a'.repeat(64)}`
    const snapshot = projectPermissionGrantSnapshot([
      {
        id: 'grant-command-group',
        revision: 1,
        capability: {
          kind: 'execution',
          key: 'exec:agent/shell',
          qualifier: { mode: 'category', value: digest }
        },
        scope: { kind: 'global' }
      }
    ])

    expect(snapshot.grants[0]).toMatchObject({ qualifierLabel: 'Command group' })
    expect(JSON.stringify(snapshot)).not.toContain(digest)
  })

  it('discloses when a broader grant still covers a revocable row', () => {
    const capability = { kind: 'execution' as const, key: 'exec:local/python' }
    const snapshot = projectPermissionGrantSnapshot([
      { id: 'global', revision: 1, capability, scope: { kind: 'global' } },
      {
        id: 'project',
        revision: 1,
        capability,
        scope: { kind: 'project', projectId: 'project-1' }
      },
      {
        id: 'session',
        revision: 1,
        capability,
        scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
      }
    ])

    expect(snapshot.grants.find((grant) => grant.id === 'global')?.coveredBy).toBeUndefined()
    expect(snapshot.grants.find((grant) => grant.id === 'project')?.coveredBy).toBe('global')
    expect(snapshot.grants.find((grant) => grant.id === 'session')?.coveredBy).toBe('project')
  })

  it('projects Connector block/allow coverage without mutating the grant', () => {
    const records = [
      {
        id: 'blocked',
        revision: 1,
        capability: { kind: 'mcp_tool' as const, key: 'mcp:custom-1/write' },
        scope: { kind: 'global' as const }
      },
      {
        id: 'covered',
        revision: 1,
        capability: { kind: 'mcp_tool' as const, key: 'mcp:chemistry/search' },
        scope: { kind: 'global' as const }
      }
    ]
    const snapshot = projectPermissionGrantSnapshot(records, {
      connectorPolicy: {
        bundledConnectorIds: ['chemistry'],
        customMcpServers: [{ id: 'custom-1', name: 'renamed', enabled: true }],
        blockedToolIds: ['renamed/write'],
        askToolIds: ['renamed/write']
      }
    })

    expect(snapshot.grants.find((grant) => grant.id === 'blocked')).toMatchObject({
      connectorServerId: 'custom-1',
      connectorToolName: 'write',
      effectiveState: 'blocked_by_policy',
      policyHint: 'Blocked in Connectors; this permission is currently inactive'
    })
    expect(snapshot.grants.find((grant) => grant.id === 'covered')).toMatchObject({
      effectiveState: 'covered_by_policy',
      policyHint: 'Allowed by Connector policy even without this permission'
    })
  })

  it('does not project Connector policy onto app-owned MCP tools', () => {
    const snapshot = projectPermissionGrantSnapshot(
      [
        {
          id: 'notebook',
          revision: 1,
          capability: {
            kind: 'mcp_tool',
            key: 'mcp:purescience-notebook/notebook_execute'
          },
          scope: { kind: 'global' }
        }
      ],
      { connectorPolicy: { bundledConnectorIds: ['chemistry'] } }
    )

    expect(snapshot.grants[0]).not.toHaveProperty('connectorServerId')
    expect(snapshot.grants[0]).not.toHaveProperty('effectiveState')
    expect(snapshot.grants[0]).not.toHaveProperty('policyHint')
  })

  it('uses the stable customization identity for its display label', () => {
    const snapshot = projectPermissionGrantSnapshot([
      {
        id: 'customize',
        revision: 1,
        capability: { kind: 'customize_mutation', key: 'customize:agent_attach_connector' },
        scope: { kind: 'global' }
      }
    ])

    expect(snapshot.grants[0].capabilityLabel).toBe('Attach connector')
  })

  // The coverage answer is what the panel prints next to a revocable row, so a faster index may not
  // change a single one of them. This reference is the previous scan-every-other-record rule written
  // out again: comparing against it proves equality of *results*, not equality of code.
  const naiveCoveredBy = (
    record: PermissionGrantRecord,
    records: readonly PermissionGrantRecord[]
  ): 'global' | 'project' | undefined => {
    if (record.scope.kind === 'global') return undefined
    const identity = (candidate: PermissionGrantRecord): string =>
      JSON.stringify([
        candidate.capability.kind,
        candidate.capability.key,
        candidate.capability.qualifier?.mode ?? 'none',
        candidate.capability.qualifier && candidate.capability.qualifier.mode !== 'any'
          ? candidate.capability.qualifier.value
          : null
      ])
    const matching = records.filter(
      (candidate) => candidate.id !== record.id && identity(candidate) === identity(record)
    )
    if (record.scope.kind === 'session') {
      // Hoisted: the narrowing of `record.scope` does not survive into the callback below.
      const sessionProjectId = record.scope.projectId
      const matchedProject = matching.some(
        (candidate) =>
          candidate.scope.kind === 'project' && candidate.scope.projectId === sessionProjectId
      )
      if (matchedProject) return 'project'
    }
    return matching.some((candidate) => candidate.scope.kind === 'global') ? 'global' : undefined
  }

  const fixture = (count: number): PermissionGrantRecord[] => {
    // Deterministic, no randomness: the same 152-shaped mix of capabilities and scopes repeats.
    let seed = 7
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return Math.floor(seed / 65536)
    }
    return Array.from({ length: count }, (_, index) => {
      const capability = next() % 4
      const scope = next() % 4
      return {
        id: `grant-${index}`,
        revision: 1,
        capability: {
          kind: (['execution', 'mcp_tool', 'file_operation', 'builtin_tool'] as const)[capability],
          key: `cap/${capability}`,
          ...(next() % 2 === 0
            ? { qualifier: { mode: 'category' as const, value: `value-${next() % 3}` } }
            : {})
        },
        scope:
          scope === 0
            ? { kind: 'global' as const }
            : scope === 1 || scope === 2
              ? { kind: 'project' as const, projectId: `project-${scope}` }
              : { kind: 'session' as const, projectId: 'project-1', sessionId: `s-${index % 5}` }
      } as PermissionGrantRecord
    })
  }

  it('answers coverage exactly as the previous per-record scan did', () => {
    const records = fixture(152)
    const snapshot = projectPermissionGrantSnapshot(records)

    const expected = records.map((record) => [record.id, naiveCoveredBy(record, records)] as const)
    const actual = snapshot.grants.map((grant) => [grant.id, grant.coveredBy] as const)
    expect(actual).toEqual(expected)
    // The fixture has to exercise all three answers, or this test proves nothing about the index.
    expect(new Set(expected.map(([, covered]) => covered ?? 'none'))).toEqual(
      new Set(['none', 'project', 'global'])
    )
  })

  it('reads each capability identity a bounded number of times per projection', () => {
    // The cost that used to be quadratic was one `JSON.stringify` per record *per record*; counting the
    // calls pins the shape of the algorithm without timing it (a wall-clock bound would be a load test).
    const records = fixture(400)
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      projectPermissionGrantSnapshot(records)
      expect(stringify.mock.calls.length).toBeLessThan(records.length * 6)
    } finally {
      stringify.mockRestore()
    }
  })
})
