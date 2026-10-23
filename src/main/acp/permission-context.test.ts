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

  it('takes a request whose server name lives only in provider metadata as MCP when it carries its own input', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeInputWaitOutcome = vi.fn()
      const onOpenCodeMcpIdentityInProviderNameOnly = vi.fn()
      const setTimer = vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms))
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        setTimer,
        onOpenCodeInputWaitOutcome,
        onOpenCodeMcpIdentityInProviderNameOnly
      })

      // The field shape: the request's title is the bare leaf name and the server-qualified name is only
      // in `_meta`, so a title-only judgement cannot see that this is an MCP request at all.
      const restored = await context.restoreToolCall(
        permissionRequest('session-1', 'call-1', {
          title: 'notebook_execute',
          rawInput: { code: 'print(1)' },
          _meta: { toolName: 'purescience_notebook_notebook_execute' }
        }),
        {
          sessionId: 'session-1',
          framework: 'opencode',
          mcpServerNames: NOTEBOOK_SERVERS,
          isCancelled: () => false
        }
      )

      expect(restored?.toolCall.rawInput).toMatchObject({ code: 'print(1)' })
      expect(setTimer).not.toHaveBeenCalled()
      expect(onOpenCodeInputWaitOutcome).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        outcome: 'input-present',
        waitedMs: 0
      })
      expect(onOpenCodeMcpIdentityInProviderNameOnly).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        hasOwnInput: true,
        awaitsProviderInput: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a provider-metadata-only request that carries no input without ever awaiting one', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeMcpIdentityInProviderNameOnly = vi.fn()
      const onOpenCodeInputWaitSkipped = vi.fn()
      const setTimer = vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms))
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        setTimer,
        onOpenCodeInputWaitSkipped,
        onOpenCodeMcpIdentityInProviderNameOnly
      })

      const restored = await context.restoreToolCall(
        permissionRequest('session-1', 'call-1', {
          title: 'notebook_execute',
          _meta: { toolName: 'purescience_notebook_notebook_execute' }
        }),
        {
          sessionId: 'session-1',
          framework: 'opencode',
          mcpServerNames: NOTEBOOK_SERVERS,
          isCancelled: () => false,
          awaitsProviderInput: false
        }
      )

      expect(restored?.toolCall.toolCallId).toBe('call-1')
      // The reading is the point here: an empty request of this shape must not start a wait whose input
      // the update path (also keyed on the title) could never store.
      expect(setTimer).not.toHaveBeenCalled()
      expect(onOpenCodeInputWaitSkipped).not.toHaveBeenCalled()
      expect(onOpenCodeMcpIdentityInProviderNameOnly).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        hasOwnInput: false,
        awaitsProviderInput: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the provider-metadata-only shape once per call and stays silent for the ordinary one', async () => {
    const onOpenCodeMcpIdentityInProviderNameOnly = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting(),
      onOpenCodeMcpIdentityInProviderNameOnly
    })
    const shape = {
      title: 'notebook_execute',
      rawInput: { code: 'print(1)' },
      _meta: { toolName: 'purescience_notebook_notebook_execute' }
    }
    const restoreContext = {
      sessionId: 'session-1',
      framework: 'opencode' as const,
      mcpServerNames: NOTEBOOK_SERVERS,
      isCancelled: () => false
    }

    await context.restoreToolCall(permissionRequest('session-1', 'call-1', shape), restoreContext)
    await context.restoreToolCall(permissionRequest('session-1', 'call-1', shape), restoreContext)
    await context.restoreToolCall(
      permissionRequest('session-1', 'call-2', { rawInput: { code: 'print(2)' } }),
      restoreContext
    )

    expect(onOpenCodeMcpIdentityInProviderNameOnly).toHaveBeenCalledTimes(1)
    expect(context.snapshot()).toEqual({ pendingRequests: [], sessions: {} })
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

  it('stays silent for an input-bearing update that nobody was waiting for', async () => {
    const onOpenCodeToolCallUpdateUnusable = vi.fn()
    const onOpenCodeInputArrivedLate = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting(),
      onOpenCodeToolCallUpdateUnusable,
      onOpenCodeInputArrivedLate
    })

    // The field shape that filled the log: a local tool call reporting its own arguments. It carries an
    // input, its title cannot be tied to a configured server, and no wait exists for it -- reporting a
    // dropout here made normal traffic look like lost provider input (77 rows / 49 calls / 14 sessions
    // over two days, none of them sharing a tool call with the 290 waits that timed out).
    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'bash',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'ls -la' }
        }
      },
      'opencode'
    )

    expect(onOpenCodeToolCallUpdateUnusable).not.toHaveBeenCalled()
    expect(onOpenCodeInputArrivedLate).not.toHaveBeenCalled()

    // A request that decides from the tool's identity alone never reads the input, so the dropped bytes
    // are not a loss even now that the request exists.
    await context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
      sessionId: 'session-1',
      framework: 'opencode',
      mcpServerNames: NOTEBOOK_SERVERS,
      isCancelled: () => false,
      awaitsProviderInput: false
    })
    expect(onOpenCodeToolCallUpdateUnusable).not.toHaveBeenCalled()
    expect(context.snapshot().sessions['session-1']).toBeUndefined()
  })

  it('reports the drop when the request for the same call turns out to wait for that input', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeToolCallUpdateUnusable = vi.fn()
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        onOpenCodeWaitTimeout: vi.fn(),
        onOpenCodeToolCallUpdateUnusable
      })

      // The provider's real order: the input arrives first (bare title, so it cannot be tied to a
      // configured server), the permission request comes 300 ms later with no input of its own.
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
      expect(onOpenCodeToolCallUpdateUnusable).not.toHaveBeenCalled()

      const restored = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
        sessionId: 'session-1',
        framework: 'opencode',
        mcpServerNames: NOTEBOOK_SERVERS,
        isCancelled: () => false
      })

      // Reported because the wait that starts here is waiting for exactly those bytes.
      expect(onOpenCodeToolCallUpdateUnusable).toHaveBeenCalledTimes(1)
      expect(onOpenCodeToolCallUpdateUnusable).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        reason: 'not-an-mcp-title',
        title: 'knowledge_list_sources',
        hasProviderName: false
      })

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(restored).resolves.toBeDefined()
      expect(onOpenCodeToolCallUpdateUnusable).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says whether a dropped input could have been routed by provider metadata', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeToolCallUpdateUnusable = vi.fn()
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        onOpenCodeWaitTimeout: vi.fn(),
        onOpenCodeToolCallUpdateUnusable
      })

      // The same bare title as the field log, but this update also names its server in `_meta`. The title
      // check runs first and takes the input with it, so this flag is the only record that the provider
      // did say which server it came from -- the difference between "never named" and "named elsewhere".
      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'notebook_execute',
            kind: 'other',
            status: 'pending',
            rawInput: { code: 'print(1)' },
            _meta: { toolName: 'purescience_notebook_notebook_execute' }
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

      expect(onOpenCodeToolCallUpdateUnusable).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        reason: 'not-an-mcp-title',
        title: 'notebook_execute',
        hasProviderName: true
      })

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(restored).resolves.toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a dropped input once, and only while a wait is pending', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeToolCallUpdateUnusable = vi.fn()
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        onOpenCodeWaitTimeout: vi.fn(),
        onOpenCodeToolCallUpdateUnusable
      })

      const restored = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
        sessionId: 'session-1',
        framework: 'opencode',
        mcpServerNames: NOTEBOOK_SERVERS,
        isCancelled: () => false
      })

      // The pending wait is what makes this drop a loss: the input that arrives is the only thing it is
      // waiting for, and it is thrown away because the update's title is the bare tool name.
      await vi.advanceTimersByTimeAsync(40)
      const bareTitleUpdate: SessionNotification = {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          title: 'knowledge_list_sources',
          status: 'in_progress',
          rawInput: { limit: 5 }
        }
      }
      observe(context, bareTitleUpdate, 'opencode')
      observe(context, bareTitleUpdate, 'opencode')

      expect(onOpenCodeToolCallUpdateUnusable).toHaveBeenCalledTimes(1)
      expect(onOpenCodeToolCallUpdateUnusable).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        reason: 'not-an-mcp-title',
        title: 'knowledge_list_sources',
        hasProviderName: false
      })

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(restored).resolves.toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies a bare-title input that arrives after the wait gave up as late, not as a drop', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeToolCallUpdateUnusable = vi.fn()
      const onOpenCodeInputArrivedLate = vi.fn()
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        onOpenCodeWaitTimeout: vi.fn(),
        onOpenCodeToolCallUpdateUnusable,
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

      await vi.advanceTimersByTimeAsync(250)
      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            title: 'knowledge_list_sources',
            status: 'in_progress',
            rawInput: { limit: 5 }
          }
        },
        'opencode'
      )

      expect(onOpenCodeInputArrivedLate).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        lateMs: 250
      })
      expect(onOpenCodeToolCallUpdateUnusable).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
