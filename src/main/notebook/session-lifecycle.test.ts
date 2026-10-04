import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  NotebookSessionLifecycleOwner,
  NotebookSessionProjectMismatchError
} from './session-lifecycle'

// The window learns that a notebook exists from `notebook:available`, and the pane is unreachable without
// it: `NotebookSessionLifecycleOwner.notifyAvailable` used to be the only emitter, and it had no caller on
// the run paths — an agent Bash run therefore never announced its notebook, the composer never offered the
// entry, and the pane (with its per-cell re-run control) could not be opened at all.

type NotifyOptions = ConstructorParameters<typeof NotebookSessionLifecycleOwner>[0]

const createOwner = (
  onNotebookAvailable: (event: unknown) => void
): NotebookSessionLifecycleOwner => {
  const options = {
    callbacks: { onNotebookAvailable, onNotebookChanged: vi.fn() },
    toSessionReference: (session: { sessionId: string }) => ({
      sessionId: session.sessionId,
      projectName: 'p',
      workspaceRoot: '/w',
      status: 'ready'
    })
  } as unknown as NotifyOptions

  return new NotebookSessionLifecycleOwner(options)
}

const session = (sessionId: string): { sessionId: string } => ({ sessionId })

describe('notebook availability announcement', () => {
  it('announces an agent-side notebook once per session', () => {
    const onAvailable = vi.fn()
    const owner = createOwner(onAvailable)

    owner.notifyAvailable(session('s1') as never, 'agent')
    owner.notifyAvailable(session('s1') as never, 'agent')

    expect(onAvailable).toHaveBeenCalledTimes(1)
    expect(onAvailable.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's1' })
  })

  it('never announces a user-side run', () => {
    const onAvailable = vi.fn()
    const owner = createOwner(onAvailable)

    owner.notifyAvailable(session('s1') as never, 'user')

    expect(onAvailable).not.toHaveBeenCalled()
  })

  it('keeps the announcement on every path a run can take', () => {
    // A behaviour test cannot see this: the defect was a missing call, not a wrong one. Reading the run
    // facades is the cheapest way to keep the next run path from quietly dropping the announcement.
    const source = readFileSync(join(__dirname, 'runtime-service.ts'), 'utf8')
    const facades = ['async runCell(', 'async executeControl(', 'async executeShell(']

    for (const facade of facades) {
      const body = source.slice(
        source.indexOf(facade),
        source.indexOf('\n  }\n', source.indexOf(facade))
      )
      expect(body, `${facade} must announce the notebook`).toContain('notifyAvailable(')
    }
  })
})

// A session's project is part of its identity: the registry keys by sessionId alone, so a caller that names
// a different project would otherwise be answered from another project's document without any sign that
// anything was wrong. These pin the refusal (and that the default project name still works).
describe('notebook session project ownership', () => {
  const createEnsureOwner = (sessionProject: string): NotebookSessionLifecycleOwner =>
    new NotebookSessionLifecycleOwner({
      defaultProjectName: 'default-project',
      sessions: {
        getOrCreate: async () => ({ sessionId: 's1', projectName: sessionProject })
      }
    } as unknown as NotifyOptions)

  it('resolves a session under its own project name', async () => {
    const owner = createEnsureOwner('project-a')

    await expect(
      owner.ensure({ sessionId: 's1', workspaceCwd: '/w', projectName: 'project-a' })
    ).resolves.toMatchObject({ sessionId: 's1', projectName: 'project-a' })
  })

  it('refuses a caller naming a different project instead of answering another project history', async () => {
    const owner = createEnsureOwner('project-a')

    await expect(
      owner.ensure({ sessionId: 's1', workspaceCwd: '/w', projectName: 'display-name' })
    ).rejects.toBeInstanceOf(NotebookSessionProjectMismatchError)
  })

  it('falls back to the default project name when the caller omits it', async () => {
    const owner = createEnsureOwner('default-project')

    await expect(owner.ensure({ sessionId: 's1', workspaceCwd: '/w' })).resolves.toMatchObject({
      projectName: 'default-project'
    })
  })

  it('serves a session as it is when the caller omits the name, instead of relabelling it', async () => {
    // The local RPC / agent path sends no project name at all, so an omitted name must never be treated as a
    // claim about a different project: the session's own project stands.
    const owner = createEnsureOwner('project-a')

    await expect(owner.ensure({ sessionId: 's1', workspaceCwd: '/w' })).resolves.toMatchObject({
      sessionId: 's1',
      projectName: 'project-a'
    })
  })
})
