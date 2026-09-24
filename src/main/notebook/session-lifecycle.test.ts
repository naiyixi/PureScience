import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { NotebookSessionLifecycleOwner } from './session-lifecycle'

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
