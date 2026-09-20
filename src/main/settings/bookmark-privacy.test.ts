import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BOOKMARK_AGENT_VISIBILITY } from '../../shared/bookmark'
import { RENDERER_CONTRACT_GROUPS } from '../../shared/renderer-contract-catalog'

// Session bookmarks are private by construction: they exist on the renderer surface and nowhere the
// agent can reach. This test is the guard — it fails if someone later wires a bookmark tool into the
// agent's capability roster, registers an MCP server for it, or promotes the channels off the local
// surface. A privacy promise that only lives in a comment is not a promise.

const repoRoot = join(__dirname, '..', '..', '..')

const capabilityOwnerSource = readFileSync(
  join(__dirname, '..', 'acp', 'session-capability-owner.ts'),
  'utf8'
)

describe('session bookmarks stay out of the agent surface', () => {
  it('declares the user-only contract in the shared module', () => {
    expect(BOOKMARK_AGENT_VISIBILITY).toBe('user-only')
  })

  it('is absent from the agent capability roster while annotations remain present', () => {
    const rosterBlock = capabilityOwnerSource.slice(
      capabilityOwnerSource.indexOf('const CURRENT_PRIMARY_CAPABILITIES'),
      capabilityOwnerSource.indexOf(
        '] as const',
        capabilityOwnerSource.indexOf('const CURRENT_PRIMARY_CAPABILITIES')
      )
    )
    expect(rosterBlock).toContain("'annotation'")
    expect(rosterBlock).not.toContain("'bookmark'")
  })

  it('has no agent-facing MCP server module', () => {
    expect(existsSync(join(__dirname, 'bookmark-mcp-server.ts'))).toBe(false)
    expect(capabilityOwnerSource).not.toContain('bookmark-mcp-server')
    // The agent framework's server registry is the other door into a model context.
    const frameworkFiles = ['claude-code.ts', 'opencode.ts', 'codex.ts', 'codebuddy.ts']
    for (const file of frameworkFiles) {
      const path = join(__dirname, '..', 'agent-framework', file)
      if (!existsSync(path)) continue
      expect(readFileSync(path, 'utf8')).not.toContain('bookmark')
    }
    expect(existsSync(join(repoRoot, 'src', 'main', 'settings', 'bookmark-mcp-server.ts'))).toBe(
      false
    )
  })

  it('stays on the local renderer surface in the contract catalogue', () => {
    const group = RENDERER_CONTRACT_GROUPS.find(({ capability }) => capability === 'bookmark')
    expect(group).toBeDefined()
    for (const contract of group?.contracts ?? []) {
      expect(contract.surfaceInstallation.electron).toBe('preload')
      expect(contract.surfaceInstallation.localWeb).toBe('web-rpc')
      // Never exposed to a remote (paired-browser) surface: the reading trail is device-local.
      expect(contract.surfaceInstallation.remoteWeb).not.toBe('web-rpc')
    }
  })
})
