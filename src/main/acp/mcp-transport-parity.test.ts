import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Drift guard for the defect this transport work uncovered: the HTTP branch of the capability owner
// covered only 4 of the 14 capabilities, so a session switched to http silently lost ten tools — and
// nothing failed. These assertions pin "both transports carry the same set" at the source level, so
// adding a capability to one side only turns red here instead of shipping a half-empty session.

const ownerSource = readFileSync(new URL('./session-capability-owner.ts', import.meta.url), 'utf8')
const hostSource = readFileSync(new URL('./mcp-http-host.ts', import.meta.url), 'utf8')

const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0

const serverKinds = (): string[] => {
  const match = /const SERVER_KINDS = \[([\s\S]*?)\] as const/u.exec(hostSource)
  if (!match?.[1]) throw new Error('SERVER_KINDS not found in mcp-http-host.ts')
  return [...match[1].matchAll(/'([a-z-]+)'/gu)].map((entry) => entry[1] as string)
}

const registerMethodFor = (kind: string): string =>
  `register${kind
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}`

describe('MCP transports stay in step', () => {
  it('serves as many capabilities over http as it spawns over stdio', () => {
    const stdioServers = count(ownerSource, /create[A-Za-z]+McpServerConfig\(\{/gu)
    const httpServers = count(ownerSource, /type: 'http'/gu)

    expect(stdioServers).toBeGreaterThanOrEqual(14)
    expect(httpServers).toBe(stdioServers)
  })

  it('gives every hosted kind a registry slot, a register method and a build branch', () => {
    const kinds = serverKinds()
    expect(kinds.length).toBeGreaterThanOrEqual(14)

    for (const kind of kinds) {
      expect(hostSource).toContain(`${registerMethodFor(kind)}(routingId: string`)
      if (kind === 'skill-import') {
        // The skill-import server is the only branch that needs more than the environment, so it is
        // written as an explicit guard instead of a `kind === '...'` comparison.
        expect(hostSource).toContain("if (kind !== 'skill-import') return undefined")
      } else {
        expect(hostSource).toContain(`if (kind === '${kind}') {`)
      }
    }
  })

  it('keeps the http host from silently answering an unknown kind', () => {
    // A fall-through would build the skill-import server for any unmatched kind; the guard makes an
    // unknown kind resolve to "not registered" (404) instead of the wrong capability.
    expect(hostSource).toContain("if (kind !== 'skill-import') return undefined")
  })
})
