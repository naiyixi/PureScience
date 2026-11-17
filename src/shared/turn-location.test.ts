import { describe, expect, it } from 'vitest'

import { projectRootForSessionCwd, turnLocationDirective } from './turn-location'

describe('projectRootForSessionCwd', () => {
  it('reads the root a session scratch directory belongs to', () => {
    expect(projectRootForSessionCwd('/Users/me/.purescience/workspaces/0f2b')).toBe(
      '/Users/me/.purescience'
    )
  })

  it('tolerates trailing slashes', () => {
    expect(projectRootForSessionCwd('/Users/me/.purescience/workspaces/0f2b/')).toBe(
      '/Users/me/.purescience'
    )
  })

  it('refuses paths that are not one of our scratch directories', () => {
    // A user-chosen project folder must never be relabelled as something else.
    expect(projectRootForSessionCwd('/Users/me/research/my-project')).toBeNull()
    expect(projectRootForSessionCwd('/workspaces/0f2b')).toBeNull()
    expect(projectRootForSessionCwd('')).toBeNull()
  })
})

describe('turnLocationDirective', () => {
  it('names both directories, and says which one holds project files', () => {
    const directive = turnLocationDirective('/Users/me/.purescience/workspaces/0f2b')

    expect(directive).toContain('working directory: /Users/me/.purescience/workspaces/0f2b')
    expect(directive).toContain('project files: /Users/me/.purescience')
    expect(directive).toContain('by absolute path')
  })

  it('returns null for a turn with no scratch directory', () => {
    expect(turnLocationDirective(undefined)).toBeNull()
    expect(turnLocationDirective('/Users/me/research/my-project')).toBeNull()
  })
})
