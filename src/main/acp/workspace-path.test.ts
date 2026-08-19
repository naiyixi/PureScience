import { describe, expect, it } from 'vitest'

import { assertWorkspacePath, isPathInsideWorkspace } from './workspace-path'

describe('workspace path guard', () => {
  it('allows the workspace root and descendants', () => {
    const workspaceRoot = '/tmp/purescience'

    expect(isPathInsideWorkspace(workspaceRoot, workspaceRoot)).toBe(true)
    expect(isPathInsideWorkspace(workspaceRoot, '/tmp/purescience/src/main/index.ts')).toBe(true)
  })

  it('rejects sibling paths that only share the same prefix', () => {
    expect(isPathInsideWorkspace('/tmp/purescience', '/tmp/purescience-backup/notes.txt')).toBe(
      false
    )
  })

  it('throws a clear error for paths outside the workspace', () => {
    expect(() => assertWorkspacePath('/tmp/purescience', '/tmp/elsewhere/file.txt')).toThrow(
      /outside the active ACP workspace/
    )
  })
})
