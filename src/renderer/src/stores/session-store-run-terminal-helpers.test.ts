import { describe, expect, it } from 'vitest'
import type { ChatSession } from './session-store-persistence-owner'
import {
  projectAgentPromptInFlight,
  projectArtifactError
} from './session-store-run-terminal-helpers'

const session = (overrides: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'test',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }) as ChatSession

// A finalization failure used to mark the session `error` and nothing ever cleared it: `clearArtifactError`
// only runs when a later finalization succeeds in the same turn, while `projectFinishedRun` deliberately
// keeps the artifact error. The session then stays red for the rest of its life — which is what made the
// verification sessions look permanently broken.
describe('projectAgentPromptInFlight', () => {
  it('clears the previous turn artifact error when a new prompt starts', () => {
    const failed = projectArtifactError(
      session(),
      'root Frame does not match the durable Session graph'
    )
    expect(failed.status).toBe('error')

    const next = projectAgentPromptInFlight(failed, true)

    expect(next.agentPromptInFlight).toBe(true)
    expect(next.status).toBe('idle')
    expect(next.error).toBeUndefined()
    expect(next.errorReportable).toBeUndefined()
  })

  it('leaves an unrelated error alone when a new prompt starts', () => {
    const failed = session({ status: 'error', error: 'provider rejected the request' })

    const next = projectAgentPromptInFlight(failed, true)

    expect(next.error).toBe('provider rejected the request')
    expect(next.status).toBe('error')
  })
})
