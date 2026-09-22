import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ALL_CONNECTOR_IDS, getConnectorTools } from './registry'

// The maturity block in both READMEs states how many scientific connectors and tools ship. That number
// went stale the moment a connector was added, and the release page now repeats the block verbatim, so
// the claim is pinned to the registry here rather than trusted.
const READMES = ['README.md', 'README.en.md']

const readClaim = (name: string): { connectors: number; tools: number } => {
  const text = readFileSync(resolve(__dirname, '..', '..', '..', name), 'utf8')
  const match = text.match(/(\d+) connectors \((\d+) tools/)
  if (!match) throw new Error(`${name} does not state the connector and tool counts`)
  return { connectors: Number(match[1]), tools: Number(match[2]) }
}

describe('README connector counts', () => {
  it('match the registry that actually ships', () => {
    const actual = {
      connectors: ALL_CONNECTOR_IDS.length,
      tools: ALL_CONNECTOR_IDS.reduce((sum, id) => sum + getConnectorTools(id).length, 0)
    }
    const claims = READMES.map((name) => ({ name, ...readClaim(name) }))

    for (const claim of claims) {
      expect({ name: claim.name, connectors: claim.connectors }).toEqual({
        name: claim.name,
        connectors: actual.connectors
      })
      expect({ name: claim.name, tools: claim.tools }).toEqual({
        name: claim.name,
        tools: actual.tools
      })
    }
  })
})
