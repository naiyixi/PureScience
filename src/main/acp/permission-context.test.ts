import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { opencodeFramework } from '../agent-framework'
import {
  AcpPermissionContext,
  AGENT_PERMISSION_ACTION_ORIGIN,
  HUMAN_PERMISSION_ACTION_ORIGIN
} from './permission-context'
import type { AcpPermissionContextOptions } from './permission-context'

/**
 * How long a coordination wait may take.
 *
 * Every `vi.waitFor` in this file is a *coordination* wait: it waits for the side effect of work that
 * is already in flight (a spy being called, a process dying, a worker reporting that it started, a
 * rendered node reaching its final text), never for something that may never happen. The only thing
 * the window has to cover is how long a loaded machine takes to schedule that continuation -- so the
 * default 1s is a quiet-machine budget, not a correctness budget. Measured on this repository: under
 * load a coordinated wait took up to 704ms (34 samples, p90 = 361ms), and a site elsewhere in the
 * suite failed at ~1.1s under load average ~70 while passing on a quiet machine.
 *
 * 30s matches the window this repository already uses for load-sensitive waits, and it stays well below
 * vitest's 60s per-test timeout, so an assertion that is genuinely stuck still fails as a failure
 * instead of hanging.
 */
const COORDINATION_WINDOW_MS = 30_000

const NOTEBOOK_SERVERS = ['purescience-notebook']

const permissionRouting = (
  overrides: Partial<NonNullable<AcpPermissionContextOptions['routing']>> = {}
): NonNullable<AcpPermissionContextOptions['routing']> => ({
  resolveAppSessionId: (sessionId) => sessionId,
  sessionSnapshot: () => ({
    cwd: '/workspace',
    frameworkId: 'opencode',
    permissionProfile: { selectedProfile: 'ask' }
  }),
  hasActivePrimarySession: () => true,
  capturePrompt: () => undefined,
  currentInteractionSequence: () => undefined,
  mcpServerNamesFor: () => NOTEBOOK_SERVERS,
  reviewerContextFor: () => undefined,
  resolveReviewerPermission: () => undefined,
  currentFramework: () => opencodeFramework,
  resolveProjectId: () => 'default-project',
  ...overrides
})

const permissionRequest = (
  sessionId: string,
  toolCallId: string,
  overrides: Partial<RequestPermissionRequest['toolCall']> = {}
): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId,
    title: 'purescience_notebook_notebook_execute',
    kind: 'other',
    status: 'pending',
    rawInput: {},
    ...overrides
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const observe = (
  context: AcpPermissionContext,
  notification: SessionNotification,
  framework: 'codex' | 'opencode' | 'claude-code'
): void => {
  context.observeToolCall(notification, {
    sessionId: notification.sessionId,
    framework,
    mcpServerNames: NOTEBOOK_SERVERS
  })
}

describe('ACP permission context', () => {
  it('cancels a late OpenCode primary request when no prompt owns the active Session', async () => {
    const emitPermissionRequest = vi.fn()
    const resolveReviewerPermission = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest,
      routing: permissionRouting({ resolveReviewerPermission })
    })

    await expect(
      context.handleProviderRequest(
        permissionRequest('primary-session', 'late-call', { title: 'Bash', kind: 'execute' })
      )
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(resolveReviewerPermission).not.toHaveBeenCalled()
    expect(emitPermissionRequest).not.toHaveBeenCalled()
  })

  it('routes an isolated OpenCode reviewer request without a primary attachment', async () => {
    const reviewerResponse = {
      outcome: { outcome: 'selected' as const, optionId: 'reject-once' }
    }
    const resolveReviewerPermission = vi.fn(() => reviewerResponse)
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting({
        hasActivePrimarySession: () => false,
        reviewerContextFor: () => ({
          frameworkId: 'opencode',
          mcpServerNames: ['purescience-reviewer']
        }),
        resolveReviewerPermission
      })
    })
    const request = permissionRequest('reviewer-session', 'reviewer-call', {
      title: 'Bash',
      kind: 'execute'
    })

    await expect(context.handleProviderRequest(request)).resolves.toEqual(reviewerResponse)
    expect(resolveReviewerPermission).toHaveBeenCalledWith(request)
  })

  it('correlates provider updates under the stable adopted Session identity', () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting({
        resolveAppSessionId: () => 'stable-session',
        sessionSnapshot: () => ({
          frameworkId: 'codex',
          permissionProfile: { selectedProfile: 'ask' }
        })
      })
    })

    context.observeProviderUpdate({
      sessionId: 'provider-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'mcp.purescience_notebook.notebook_execute',
        kind: 'execute',
        status: 'pending',
        rawInput: {
          server: 'purescience_notebook',
          tool: 'notebook_execute',
          arguments: { language: 'python', code: 'print(1)' }
        },
        _meta: { is_mcp_tool_call: true }
      }
    })

    expect(context.snapshot().sessions).toMatchObject({
      'stable-session': { codexMcpIdentities: 1 }
    })
    expect(context.snapshot().sessions).not.toHaveProperty('provider-session')
  })

  it('correlates sparse Codex approvals and bounds retained provider aliases', async () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting()
    })

    for (let index = 0; index < 40; index += 1) {
      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `call-${index}`,
            kind: 'execute',
            title: 'mcp.purescience_notebook.notebook_execute',
            status: 'pending',
            rawInput: {
              server: 'purescience_notebook',
              tool: 'notebook_execute',
              arguments: { language: 'python', code: `print(${index})` }
            },
            _meta: { is_mcp_tool_call: true }
          }
        },
        'codex'
      )
    }

    expect(context.snapshot()).toEqual({
      pendingRequests: [],
      sessions: {
        'session-1': {
          codexMcpIdentities: 32,
          claudeCodeMcpInputs: 0,
          opencodeMcpInputs: 0,
          opencodeNativeSkills: 0,
          opencodeClosedToolCalls: 0,
          pendingWaiters: 0
        }
      }
    })

    const restored = await context.restoreToolCall(
      {
        ...permissionRequest('session-1', 'call-39', {
          title: undefined,
          kind: 'execute',
          rawInput: undefined
        }),
        _meta: { is_mcp_tool_approval: true }
      },
      {
        sessionId: 'session-1',
        framework: 'codex',
        mcpServerNames: NOTEBOOK_SERVERS,
        isCancelled: () => false
      }
    )

    expect(restored?.toolCall).toMatchObject({
      title: 'mcp.purescience_notebook.notebook_execute',
      rawInput: { language: 'python', code: 'print(39)' },
      _meta: { toolName: 'notebook_execute' }
    })
  })

  it('rendezvouses an OpenCode request with a bounded late preview and removes its waiter', async () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting()
    })
    const code = 'x <- 1\n'.repeat(2_000)

    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'purescience_notebook_notebook_execute',
          kind: 'other',
          status: 'pending',
          rawInput: {}
        }
      },
      'opencode'
    )

    const restored = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
      sessionId: 'session-1',
      framework: 'opencode',
      mcpServerNames: NOTEBOOK_SERVERS,
      isCancelled: () => false
    })

    await vi.waitFor(
      () => expect(context.snapshot().sessions['session-1']?.pendingWaiters).toBe(1),
      { timeout: COORDINATION_WINDOW_MS }
    )

    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'in_progress',
          rawInput: { language: 'r', code }
        }
      },
      'opencode'
    )

    const result = await restored
    expect(result?.toolCall.rawInput).toEqual({
      language: 'r',
      code: code.slice(0, 7_500),
      inputTruncated: true
    })
    expect(context.snapshot().sessions['session-1']?.pendingWaiters ?? 0).toBe(0)
  })

  it('keeps a human-only decision parked when an agent-origin action tries to resolve it', async () => {
    const emitted: Array<{ requestId: string }> = []
    const context = new AcpPermissionContext({
      emitPermissionRequest: (request) => emitted.push(request),
      routing: permissionRouting()
    })
    const pending = context.requestPermission(permissionRequest('session-1', 'call-1'))

    await expect(
      context.respondToPermission(
        { requestId: emitted[0].requestId, optionId: 'allow-once' },
        AGENT_PERMISSION_ACTION_ORIGIN
      )
    ).resolves.toBe(false)
    expect(context.snapshot().pendingRequests).toEqual([
      {
        requestId: emitted[0].requestId,
        sessionId: 'session-1',
        toolCallId: 'call-1',
        requiredOrigin: 'human'
      }
    ])

    await expect(
      context.respondToPermission(
        { requestId: emitted[0].requestId, optionId: 'allow-once' },
        HUMAN_PERMISSION_ACTION_ORIGIN
      )
    ).resolves.toBe(true)
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    } satisfies RequestPermissionResponse)
  })

  it('drops waiter and preview residue when OpenCode correlation times out', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeWaitTimeout = vi.fn()
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        onOpenCodeWaitTimeout
      })
      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'purescience_notebook_notebook_execute',
            kind: 'other',
            status: 'pending',
            rawInput: {}
          }
        },
        'opencode'
      )
      const restored = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
        sessionId: 'session-1',
        framework: 'opencode',
        mcpServerNames: NOTEBOOK_SERVERS,
        isCancelled: () => false
      })

      await vi.advanceTimersByTimeAsync(1_000)

      await expect(restored).resolves.toMatchObject({
        toolCall: { _meta: { toolName: 'purescience_notebook_notebook_execute' } }
      })
      expect(onOpenCodeWaitTimeout).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        waitMs: 1_000
      })
      expect(context.snapshot()).toEqual({ pendingRequests: [], sessions: {} })
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the input wait when the decision cannot read the input', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeWaitTimeout = vi.fn()
      const onOpenCodeInputWaitSkipped = vi.fn()
      const setTimer = vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms))
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        onOpenCodeWaitTimeout,
        onOpenCodeInputWaitSkipped,
        setTimer
      })

      // No `tool_call` update ever arrives for this call, which is exactly the field shape: the provider
      // never sends the late raw input these waits are waiting for.
      const restored = await context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
        sessionId: 'session-1',
        framework: 'opencode',
        mcpServerNames: NOTEBOOK_SERVERS,
        isCancelled: () => false,
        awaitsProviderInput: false
      })

      expect(restored?.toolCall.toolCallId).toBe('call-1')
      expect(setTimer).not.toHaveBeenCalled()
      expect(onOpenCodeWaitTimeout).not.toHaveBeenCalled()
      expect(onOpenCodeInputWaitSkipped).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        reason: 'identity-only-decision'
      })
      expect(context.snapshot()).toEqual({ pendingRequests: [], sessions: {} })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a request whose input was already in hand as a wait that cost nothing', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeInputWaitOutcome = vi.fn()
      const setTimer = vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms))
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        setTimer,
        onOpenCodeInputWaitOutcome
      })

      const restored = await context.restoreToolCall(
        permissionRequest('session-1', 'call-1', { rawInput: { code: 'print(1)' } }),
        {
          sessionId: 'session-1',
          framework: 'opencode',
          mcpServerNames: NOTEBOOK_SERVERS,
          isCancelled: () => false
        }
      )

      expect(restored?.toolCall.rawInput).toMatchObject({ code: 'print(1)' })
      expect(setTimer).not.toHaveBeenCalled()
      expect(onOpenCodeInputWaitOutcome).toHaveBeenCalledTimes(1)
      expect(onOpenCodeInputWaitOutcome).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        outcome: 'input-present',
        waitedMs: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a wait that resolved, which used to leave no trace at all', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeInputWaitOutcome = vi.fn()
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        onOpenCodeInputWaitOutcome
      })

      const restored = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
        sessionId: 'session-1',
        framework: 'opencode',
        mcpServerNames: NOTEBOOK_SERVERS,
        isCancelled: () => false
      })

      await vi.advanceTimersByTimeAsync(40)
      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            title: 'purescience_notebook_notebook_execute',
            status: 'in_progress',
            rawInput: { code: 'print(2)' }
          }
        },
        'opencode'
      )

      await expect(restored).resolves.toMatchObject({
        toolCall: { rawInput: { code: 'print(2)' } }
      })
      expect(onOpenCodeInputWaitOutcome).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        outcome: 'resolved',
        waitedMs: 40
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a wait that gave up, and reports the input that turned up afterwards as late', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeInputWaitOutcome = vi.fn()
      const onOpenCodeInputArrivedLate = vi.fn()
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        onOpenCodeWaitTimeout: vi.fn(),
        onOpenCodeInputWaitOutcome,
        onOpenCodeInputArrivedLate
      })

      const restored = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
        sessionId: 'session-1',
        framework: 'opencode',
        mcpServerNames: NOTEBOOK_SERVERS,
        isCancelled: () => false
      })

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(restored).resolves.toBeDefined()
      expect(onOpenCodeInputWaitOutcome).toHaveBeenCalledTimes(1)
      expect(onOpenCodeInputWaitOutcome).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        outcome: 'timeout',
        waitedMs: 1_000
      })

      await vi.advanceTimersByTimeAsync(250)
      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            title: 'purescience_notebook_notebook_execute',
            status: 'in_progress',
            rawInput: { code: 'print(3)' }
          }
        },
        'opencode'
      )

      expect(onOpenCodeInputArrivedLate).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        lateMs: 250
      })
      // Reported once, not on every later update for the same call.
      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            title: 'purescience_notebook_notebook_execute',
            status: 'in_progress',
            rawInput: { code: 'print(3)' }
          }
        },
        'opencode'
      )
      expect(onOpenCodeInputArrivedLate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an input-bearing update it cannot use instead of dropping it silently', () => {
    const onOpenCodeToolCallUpdateUnusable = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting(),
      onOpenCodeToolCallUpdateUnusable
    })

    // The field shape that produced the question: an update whose title is the bare tool name, so it
    // cannot be tied back to a configured server, and whose input was therefore thrown away.
    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'knowledge_list_sources',
          kind: 'read',
          status: 'pending',
          rawInput: { limit: 5 }
        }
      },
      'opencode'
    )

    expect(onOpenCodeToolCallUpdateUnusable).toHaveBeenCalledWith({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      reason: 'not-an-mcp-title',
      title: 'knowledge_list_sources'
    })
    expect(context.snapshot().sessions['session-1']).toBeUndefined()

    // An update that carried no input lost nothing, so it must not add noise to the reading.
    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-2',
          title: 'knowledge_list_sources',
          kind: 'read',
          status: 'pending'
        }
      },
      'opencode'
    )
    expect(onOpenCodeToolCallUpdateUnusable).toHaveBeenCalledTimes(1)
  })

  it('does not wait for input on a reviewer request, and still answers it', async () => {
    const reviewerResponse = {
      outcome: { outcome: 'selected' as const, optionId: 'allow-once' }
    }
    const onOpenCodeWaitTimeout = vi.fn()
    const onOpenCodeInputWaitSkipped = vi.fn()
    const resolveReviewerPermission = vi.fn(() => reviewerResponse)
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      onOpenCodeWaitTimeout,
      onOpenCodeInputWaitSkipped,
      routing: permissionRouting({
        // The reviewer runs while the primary turn it is reviewing is still in flight -- the same shape
        // the field logs show (the wait timed out, then the request was answered 1 ms later).
        capturePrompt: () => ({ sequence: 7, isCancellationAccepted: () => false }),
        currentInteractionSequence: () => 7,
        reviewerContextFor: () => ({
          frameworkId: 'opencode',
          mcpServerNames: ['purescience-reviewer']
        }),
        resolveReviewerPermission
      })
    })
    const request = permissionRequest('reviewer-session', 'reviewer-call', {
      title: 'purescience_reviewer_read_turn',
      kind: 'other'
    })

    // Real timers on purpose: this is the shape that used to cost the full 1,000 ms window per call.
    // With the wiring removed it fails on the two callbacks instead of on a wall-clock assertion.
    await expect(context.handleProviderRequest(request)).resolves.toEqual(reviewerResponse)
    expect(onOpenCodeInputWaitSkipped).toHaveBeenCalledWith({
      sessionId: 'reviewer-session',
      toolCallId: 'reviewer-call',
      reason: 'identity-only-decision'
    })
    expect(onOpenCodeWaitTimeout).not.toHaveBeenCalled()
    expect(resolveReviewerPermission).toHaveBeenCalledTimes(1)
  })

  it('cancels pending correlation waiters and decisions on session cleanup', async () => {
    const emitted: Array<{ requestId: string }> = []
    const context = new AcpPermissionContext({
      emitPermissionRequest: (request) => emitted.push(request),
      routing: permissionRouting()
    })

    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'purescience_notebook_notebook_execute',
          kind: 'other',
          status: 'pending',
          rawInput: {}
        }
      },
      'opencode'
    )
    const correlation = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
      sessionId: 'session-1',
      framework: 'opencode',
      mcpServerNames: NOTEBOOK_SERVERS,
      isCancelled: () => false
    })
    const decision = context.requestPermission(permissionRequest('session-1', 'call-2'))

    await vi.waitFor(
      () => expect(context.snapshot().sessions['session-1']?.pendingWaiters).toBe(1),
      { timeout: COORDINATION_WINDOW_MS }
    )
    context.cancelForSession('session-1')

    await expect(correlation).resolves.toBeUndefined()
    await expect(decision).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(context.snapshot()).toEqual({ pendingRequests: [], sessions: {} })
  })

  it('disposes every session without retaining preview or waiter metadata', async () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting()
    })
    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'purescience_notebook_notebook_execute',
          kind: 'other',
          status: 'pending',
          rawInput: {}
        }
      },
      'opencode'
    )
    const correlation = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
      sessionId: 'session-1',
      framework: 'opencode',
      mcpServerNames: NOTEBOOK_SERVERS,
      isCancelled: () => false
    })

    await vi.waitFor(
      () => expect(context.snapshot().sessions['session-1']?.pendingWaiters).toBe(1),
      { timeout: COORDINATION_WINDOW_MS }
    )
    context.dispose()

    await expect(correlation).resolves.toBeUndefined()
    expect(context.snapshot()).toEqual({ pendingRequests: [], sessions: {} })
  })
})
