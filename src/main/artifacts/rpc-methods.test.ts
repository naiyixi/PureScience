import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ARTIFACT_RPC_METHODS } from './rpc-methods'

// The artifact capability has exactly one method list (`ARTIFACT_RPC_METHODS`), and every artifact RPC
// the MCP server actually sends must be in it. A second, narrower list at a minting site denies a newly
// added method at runtime while every unittest stays green — that is not hypothetical: it shipped on
// 2026-09-13 and was only caught by a live agent turn, which failed with
// `Artifact RPC capability does not allow artifactCheckReproduction.`
//
// These assertions read the source text on purpose: the drift is a second literal list, and only the
// files' own contents can prove it is gone.

const sourceOf = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const sentMethods = (source: string): string[] => [
  ...new Set([...source.matchAll(/method: '(artifact[A-Za-z]+)'/gu)].map((match) => match[1]))
]

describe('artifact RPC method list', () => {
  it('contains every artifact method the MCP server sends', () => {
    const sent = sentMethods(sourceOf('./mcp-server.ts'))

    expect(sent).toEqual([
      'artifactCreateVersion',
      'artifactReplayVersion',
      'artifactCheckReproduction'
    ])
    for (const method of sent) {
      expect([...ARTIFACT_RPC_METHODS]).toContain(method)
    }
  })

  it('covers the artifact methods the capability exposes', () => {
    expect([...ARTIFACT_RPC_METHODS].sort()).toEqual([
      'artifactCheckReproduction',
      'artifactCreateVersion',
      'artifactReplayVersion'
    ])
  })

  it('leaves no second method list at the turn-owner minting site', () => {
    const turnOwner = sourceOf('../acp/artifact-turn-owner.ts')

    expect(turnOwner).toContain('ARTIFACT_RPC_METHODS')
    for (const method of [...ARTIFACT_RPC_METHODS]) {
      expect(turnOwner).not.toContain(`'${method}'`)
    }
  })
})
