import type { ContentBlock } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpPromptRequest } from '../../shared/acp'
import { codexFramework } from '../agent-framework/codex'
import type { ContextUsageTurnHandle } from './context-usage-tracker'
import { AcpPromptPreparationOwner, type PreparedPromptHandle } from './prompt-preparation-owner'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'

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

type Mock = ReturnType<typeof vi.fn>
type TestContextTurn = ContextUsageTurnHandle & {
  complete: Mock
  fail: Mock
  supersede: Mock
}
type Fixture = {
  owner: AcpPromptPreparationOwner
  prepare: (overrides?: Record<string, unknown>) => Promise<PreparedPromptHandle>
  promptContent: { prepare: Mock }
  contextUsage: { beginTurn: Mock; replacePromptSkillDocuments: Mock }
  turn: TestContextTurn
  turnSkill: { prepareProvider: Mock }
  authorizeReferencedUploads: Mock
  releaseGrant: Mock
  registerTurnInputs: Mock
}

const request = (overrides: Partial<AcpPromptRequest> = {}): AcpPromptRequest => ({
  sessionId: 'session-1',
  text: 'Analyze the result.',
  ...overrides
})

const contextTurn = (): TestContextTurn => {
  const handle = {
    complete: vi.fn(() => false),
    fail: vi.fn(),
    supersede: vi.fn()
  } as unknown as TestContextTurn
  return handle
}

// A double that behaves like the real vision relay where it matters here: image blocks are translated,
// every other block passes through untouched. That pass-through is the property under test.
type ImageRelayDouble = {
  prepare: (input: { content: string | ContentBlock[] }) => Promise<string | ContentBlock[]>
}

const setup = (
  inputNotice?: (request: AcpPromptRequest) => string,
  selectionNotice?: (request: AcpPromptRequest) => string,
  imageInputCompatibility?: ImageRelayDouble,
  capabilityNotice?: (request: AcpPromptRequest) => Promise<string | null>,
  capabilityGate?: (request: AcpPromptRequest) => Promise<{ message: string } | null>
): Fixture => {
  const turn = contextTurn()
  const promptContent = {
    prepare: vi.fn(async () => ({
      content: 'provider-content',
      turnInputs: { uploads: [], references: [] }
    }))
  }
  const contextUsage = {
    beginSession: vi.fn(),
    beginTurn: vi.fn(() => turn),
    commitPendingAssistantOutput: vi.fn(),
    appendText: vi.fn(),
    appendPromptContent: vi.fn(),
    replacePromptSkillDocuments: vi.fn(),
    usage: vi.fn(() => undefined),
    refreshUsage: vi.fn(() => true)
  }
  const releaseGrant = vi.fn()
  const authorizeReferencedUploads = vi.fn(async () => releaseGrant)
  const registerTurnInputs = vi.fn(async () => undefined)
  const owner = new AcpPromptPreparationOwner({
    promptContent,
    presentation: new AcpSessionPresentationPolicy(),
    contextUsage,
    selectBridgeSkills: vi.fn(async () => []),
    authorizeReferencedUploads,
    ...(inputNotice ? { inputNotice } : {}),
    ...(selectionNotice ? { selectionNotice } : {}),
    ...(imageInputCompatibility ? { imageInputCompatibility } : {}),
    ...(capabilityNotice ? { capabilityNotice } : {}),
    ...(capabilityGate ? { capabilityGate } : {}),
    notebook: {
      peekHandoffContext: vi.fn(() => ({
        executionCount: 1,
        cells: [],
        kernels: [],
        runtimes: [{ language: 'python' as const, label: 'dataset' }]
      })),
      registerTurnInputs
    },
    emitState: vi.fn()
  })
  const turnSkill = {
    reloadDecision: { kind: 'continue' as const },
    prepareProvider: vi.fn(async () => ({
      text: 'prepared task',
      specialistSkillGuidance: 'Allowed Specialist Skills for this session:\n- Research',
      codexSkillInputs: [{ name: 'Research', path: '/missing/Research/SKILL.md' }]
    })),
    close: vi.fn()
  }
  const prepare = (overrides: Record<string, unknown> = {}): Promise<PreparedPromptHandle> =>
    owner.prepare({
      request: request({
        contextReset: true,
        historyPreamble: 'replayed history',
        referencedArtifacts: [
          {
            id: 'skill-1',
            name: 'Research.skill',
            path: '/uploads/Research.skill',
            source: 'upload'
          }
        ]
      }),
      backend: {
        framework: codexFramework,
        session: { modelRequired: false },
        prompt: { systemPromptAppends: [], persistentSystemPrompt: 'baked instructions' },
        context: { window: 100_000, supportsImageInput: true },
        adapter: {
          nativeMcpEnabled: true,
          bridgeMcpAliasesEnabled: false,
          codexHome: '/codex'
        }
      },
      tooling: {
        artifacts: true,
        notebook: true,
        skillImport: true,
        memory: false,
        contextSummary: false,
        routine: false,
        goal: false,
        endpoint: false,
        annotation: false,
        pdf: false,
        knowledge: false,
        figure: false,
        query: false
      },
      specialistPrefix: 'Specialist identity.',
      projectId: 'project-1',
      fallbackPromptMessageId: 'prompt-fallback',
      bridgeSkillsAvailable: true,
      skillImportEnabled: true,
      skillImportTurnToken: 'turn-1',
      turnSkill,
      signal: new AbortController().signal,
      isCurrent: () => true,
      cancellationCheckpoint: async () => 'active' as const,
      contextEstimateInput: { frameworkId: 'codex' as const },
      selectedContextWindow: 100_000,
      ...overrides
    })

  return {
    owner,
    prepare,
    promptContent,
    contextUsage,
    turn,
    turnSkill,
    authorizeReferencedUploads,
    releaseGrant,
    registerTurnInputs
  }
}

describe('AcpPromptPreparationOwner', () => {
  it('composes handoff, presentation, Notebook and prompt content and transfers Context once', async () => {
    const fixture = setup()

    const handle = await fixture.prepare()

    expect(handle.status).toBe('ready')
    if (handle.status !== 'ready') throw new Error('expected a ready prompt')
    expect(fixture.turnSkill.prepareProvider).toHaveBeenCalledWith({
      frameworkId: 'codex',
      selectionText: 'Analyze the result.',
      promptText: 'Analyze the result.',
      codex: {
        home: '/codex',
        bridgeSkillsAvailable: true,
        selectSkills: expect.any(Function),
        signal: expect.any(AbortSignal)
      }
    })
    expect(fixture.promptContent.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        appSessionId: 'session-1',
        projectId: 'project-1',
        codexSkillInputs: [{ name: 'Research', path: '/missing/Research/SKILL.md' }],
        fileTextBudget: expect.any(Number)
      })
    )
    const preparedCalls = fixture.promptContent.prepare.mock.calls as unknown as Array<
      [{ text: string }]
    >
    const preparedText = preparedCalls[0]?.[0].text
    expect(preparedText).toEqual(expect.stringContaining('<purescience_notebook_continuity>'))
    expect(preparedText).toEqual(expect.stringContaining('"label":"dataset"'))
    expect(preparedText).toMatch(
      /^replayed history[\s\S]+Specialist identity\.\n\nAllowed Specialist Skills for this session:\n- Research\n\nprepared task$/
    )
    expect(fixture.authorizeReferencedUploads).toHaveBeenCalledWith('project-1', 'session-1', [
      '/uploads/Research.skill'
    ])
    expect(fixture.registerTurnInputs).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessageId: 'prompt-fallback' })
    )
    expect(handle.content).toBe('provider-content')
    expect(handle.promptPrefix).toBe(
      'Specialist identity.\n\nAllowed Specialist Skills for this session:\n- Research'
    )
    expect(handle.skillActivityInputs).toEqual([
      { name: 'Research', path: '/missing/Research/SKILL.md' }
    ])
    expect(Object.isFrozen(handle.skillActivityInputs)).toBe(true)
    expect(handle.transferContextTurn()).toBe(fixture.turn)
    expect(() => handle.transferContextTurn()).toThrow('already transferred')
    handle.close()
    handle.close()
    expect(fixture.releaseGrant).toHaveBeenCalledTimes(1)
    expect(fixture.turn.fail).not.toHaveBeenCalled()
  })

  it('stops a superseded prompt after stalled content preparation and releases its grant', async () => {
    const fixture = setup()
    let resolveContent!: () => void
    fixture.promptContent.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveContent = () =>
            resolve({
              content: 'stale-provider-content',
              turnInputs: { uploads: [], references: [] }
            })
        })
    )
    let current = true
    const pending = fixture.prepare({ isCurrent: () => current })
    await vi.waitFor(() => expect(fixture.promptContent.prepare).toHaveBeenCalled(), {
      timeout: COORDINATION_WINDOW_MS
    })

    current = false
    resolveContent()
    const handle = await pending

    expect(handle.status).toBe('cancelled')
    expect(fixture.releaseGrant).toHaveBeenCalledTimes(1)
    expect(fixture.contextUsage.beginTurn).not.toHaveBeenCalled()
    expect(fixture.registerTurnInputs).not.toHaveBeenCalled()
  })

  it('fails and supersedes a preparation-owned Context turn when cancellation wins preflight', async () => {
    const fixture = setup()
    let current = true
    fixture.contextUsage.replacePromptSkillDocuments.mockImplementationOnce(() => {
      current = false
    })

    const handle = await fixture.prepare({ isCurrent: () => current })

    expect(handle.status).toBe('cancelled')
    expect(fixture.turn.fail).toHaveBeenCalledTimes(1)
    expect(fixture.turn.supersede).toHaveBeenCalledTimes(1)
    expect(fixture.releaseGrant).toHaveBeenCalledTimes(1)
  })

  it('puts the missing-input notice in the provider content, not in the user text', async () => {
    const seen: string[] = []
    const fixture = setup((request) => {
      seen.push(request.text)
      return '<missing_inputs>\nsim_a.csv does not exist.\n</missing_inputs>'
    })

    const handle = await fixture.prepare()

    expect(handle.status).toBe('ready')
    if (handle.status !== 'ready') throw new Error('expected a ready prompt')
    // The model is told; the user's own message text is untouched, because that is what the transcript
    // records the user as having said.
    expect(JSON.stringify(handle.content)).toContain('<missing_inputs>')
    expect(seen).toEqual(['Analyze the result.'])
  })

  it('refuses the turn before spending a model call when the gate names a missing input', async () => {
    // The gate is app-side: the model never gets asked, because the measured failure mode was that it
    // never asks and never reads skills either.
    const fixture = setup(undefined, undefined, undefined, undefined, async () => ({
      message:
        '无法开始「needs-matrix」：缺少 omics file（input:omics_file），可先运行 fetch-geo 生成。'
    }))

    await expect(fixture.prepare()).rejects.toThrow('无法开始「needs-matrix」')
  })

  it('starts normally when the gate has nothing to refuse', async () => {
    const fixture = setup(undefined, undefined, undefined, undefined, async () => null)

    const handle = await fixture.prepare()

    expect(handle.status).toBe('ready')
  })

  it('delivers capability gaps without being asked, and keeps the user text clean', async () => {
    const seen: string[] = []
    const fixture = setup(undefined, undefined, undefined, async (request) => {
      seen.push(request.text)
      return '<purescience_capability_gaps>\n- needs-matrix 需要 omics file（input:omics_file），本会话没有；先运行 fetch-geo 生成它。\n</purescience_capability_gaps>'
    })

    const handle = await fixture.prepare()

    expect(handle.status).toBe('ready')
    if (handle.status !== 'ready') throw new Error('expected a ready prompt')
    // The whole point: the model receives the gaps on a turn where it never called the tool.
    expect(JSON.stringify(handle.content)).toContain('purescience_capability_gaps')
    expect(JSON.stringify(handle.content)).toContain('needs-matrix')
    // Application context must not masquerade as the user's words.
    expect(seen).toEqual(['Analyze the result.'])
  })

  it('leaves the provider content alone when there are no capability gaps', async () => {
    const fixture = setup(undefined, undefined, undefined, async () => null)

    const handle = await fixture.prepare()

    expect(handle.status).toBe('ready')
    if (handle.status !== 'ready') throw new Error('expected a ready prompt')
    // No gaps is a real answer, and it must not change a single byte of the turn.
    expect(handle.content).toBe('provider-content')
  })

  it('leaves the provider content alone when nothing is missing', async () => {
    const fixture = setup(() => '')

    const handle = await fixture.prepare()

    expect(handle.status).toBe('ready')
    if (handle.status !== 'ready') throw new Error('expected a ready prompt')
    expect(handle.content).toBe('provider-content')
  })

  it('puts the structure selection in the provider content, not in the user text', async () => {
    const seen: string[] = []
    const fixture = setup(undefined, (request) => {
      seen.push(request.text)
      return '<purescience_structure_context>\nchain A residues 145-160\n</purescience_structure_context>'
    })

    const handle = await fixture.prepare()

    expect(handle.status).toBe('ready')
    if (handle.status !== 'ready') throw new Error('expected a ready prompt')
    // The model is told which region is selected; `request.text` is what the transcript records the user
    // as having said, so the notice must never be folded into it.
    expect(JSON.stringify(handle.content)).toContain('<purescience_structure_context>')
    expect(seen).toEqual(['Analyze the result.'])
  })

  it('leaves the content byte-identical when the turn carries no selection', async () => {
    const fixture = setup(undefined, () => '')

    const handle = await fixture.prepare()

    expect(handle.status).toBe('ready')
    if (handle.status !== 'ready') throw new Error('expected a ready prompt')
    expect(handle.content).toBe('provider-content')
  })

  it('keeps the selection notice when a text-only backend is served by the vision relay', async () => {
    // Regression: the relay was handed the PRE-notice content, so on a text-only backend every notice
    // (D5's missing inputs and D2's selection) was silently dropped from what the model received.
    const relay: ImageRelayDouble = {
      prepare: async (input) =>
        typeof input.content === 'string'
          ? input.content
          : input.content.map((block) =>
              block.type === 'image' ? { type: 'text' as const, text: 'IMAGE EVIDENCE' } : block
            )
    }
    const fixture = setup(
      () => '<missing_inputs>sim_a.csv does not exist.</missing_inputs>',
      () =>
        '<purescience_structure_context>chain A residues 145-160</purescience_structure_context>',
      relay
    )
    fixture.promptContent.prepare.mockResolvedValueOnce({
      content: [
        { type: 'image', mimeType: 'image/png', data: 'aGk=' },
        { type: 'text', text: 'provider body' }
      ],
      turnInputs: { uploads: [], references: [] }
    })

    const handle = await fixture.prepare({
      backend: {
        framework: codexFramework,
        session: { modelRequired: false },
        prompt: { systemPromptAppends: [], persistentSystemPrompt: 'baked instructions' },
        context: { window: 100_000, supportsImageInput: false },
        adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false, codexHome: '/codex' }
      }
    })

    expect(handle.status).toBe('ready')
    if (handle.status !== 'ready') throw new Error('expected a ready prompt')
    const blocks = handle.content as ContentBlock[]
    const text = JSON.stringify(blocks)
    expect(text).toContain('<missing_inputs>')
    expect(text).toContain('<purescience_structure_context>')
    expect(text).toContain('IMAGE EVIDENCE')
    expect(text).toContain('provider body')
    // The image block itself is gone: translation happened, and it happened to the notices' content.
    expect(blocks.some((block) => block.type === 'image')).toBe(false)
  })
})
