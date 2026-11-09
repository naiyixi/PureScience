import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('../logger', () => ({
  createLogger: () => mocks
}))

import type { AcpPromptRequest, AcpStateSnapshot } from '../../shared/acp'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { continueInterruptedTurn } from './interrupted-turn-continuation'

const PROMPT_ID = 'message-interrupted-1'
const SESSION_ID = 'session-interrupted-anchor'
const PROJECT_ID = 'project-interrupted-anchor'

const interruptedSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession =>
  ({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: 'Interrupted turn',
    cwd: '/tmp',
    status: 'error',
    messages: [
      {
        id: PROMPT_ID,
        role: 'user',
        content: 'run the docking pipeline',
        status: 'complete',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    resumeRecovery: { kind: 'resume-required', promptMessageId: PROMPT_ID },
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }) as PersistedChatSession

const runContinuation = async (session: PersistedChatSession): Promise<AcpPromptRequest> => {
  const started: AcpPromptRequest[] = []
  const snapshot = {
    promptInFlightSessionIds: [],
    pendingPermissions: [],
    sessions: []
  } as unknown as AcpStateSnapshot
  await continueInterruptedTurn(
    {
      runtime: {
        getSnapshot: () => snapshot,
        getLatestUserPrompt: () => undefined,
        startContinuation: async (request) => {
          started.push(request)
        }
      },
      loadSession: async () => session
    },
    {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      promptMessageId: PROMPT_ID
    } as Parameters<typeof continueInterruptedTurn>[1]
  )
  expect(started).toHaveLength(1)
  return started[0]
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('interrupted-turn continuation provenance', () => {
  it('names the consequence when a pre-graph session has nothing durable to own the turn', async () => {
    const request = await runContinuation(interruptedSession())

    // The bare id is what an unownable prompt looks like; it can never satisfy the ownership proof,
    // so the turn's artifacts are refused terminally.
    expect(request.provenanceContext).toEqual({ promptMessageId: PROMPT_ID })
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('no Conversation Graph'),
      expect.objectContaining({
        sessionId: SESSION_ID,
        promptMessageId: PROMPT_ID,
        consequence: 'prompt-not-owned'
      })
    )
  })

  it('takes the four identities from the durable graph and stays quiet about ownership', async () => {
    const session = interruptedSession()
    const graph = createLinearConversationGraph({
      sessionId: SESSION_ID,
      messages: [
        {
          id: PROMPT_ID,
          role: 'user',
          content: 'run the docking pipeline',
          status: 'complete',
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'message-interrupted-2',
          role: 'agent',
          content: 'stopped mid-run',
          status: 'error',
          createdAt: 2,
          updatedAt: 2
        }
      ] as PersistedChatSession['messages'],
      createdAt: 1,
      updatedAt: 2
    })

    const request = await runContinuation({ ...session, conversationGraph: graph })

    expect(request.provenanceContext).toMatchObject({
      promptMessageId: PROMPT_ID,
      agentFrameId: graph.activeFrameId,
      messageBranchId: graph.frames.find((frame) => frame.id === graph.activeFrameId)
        ?.activeBranchId
    })
    expect(request.provenanceContext?.runtimeSegmentId).toBe(graph.runtimeSegments.at(-1)?.id)
    expect(mocks.warn).not.toHaveBeenCalled()
  })
})
