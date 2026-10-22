import { describe, expect, it } from 'vitest'

import {
  classifyReviewerToolCall,
  decideReviewerPermission,
  permissionDecisionResponse
} from './reviewer-session-owner'

// The reviewer permission policy decides whether a background reviewer may run the tool it just asked
// for. It had no test of its own until this file, and the shipped logs showed what that cost: the gate
// rejected 16 native tool calls and every one of them ended the review with no findings
// (`review protocol incomplete … Reviewer stopped without calling submit_findings`, 15/15 paired within
// 2.1 s). 9 of the 16 were ACP kind `think` — a reasoning step with no filesystem, network or process
// capability, so refusing it protected nothing.
//
// These cases pin the three-way split and, just as importantly, the shapes that must STILL be refused:
// a shell (`execute`), a file read (`read`), a network fetch (`fetch`), and a reviewer tool requested
// under two MCP servers at once.

const reviewerServer = 'purescience_reviewer'

const options = [
  { optionId: 'opt-allow', kind: 'allow_once' },
  { optionId: 'opt-reject', kind: 'reject_once' }
]

const decide = (
  toolCall: { title?: unknown; kind?: unknown; _meta?: unknown } | undefined,
  overrides: {
    frameworkId?: string
    mcpServerNames?: readonly string[]
    options?: typeof options
  } = {}
): ReturnType<typeof decideReviewerPermission> =>
  decideReviewerPermission({
    toolCall,
    options: overrides.options ?? options,
    frameworkId: (overrides.frameworkId ?? 'opencode') as Parameters<
      typeof decideReviewerPermission
    >[0]['frameworkId'],
    mcpServerNames: overrides.mcpServerNames ?? [reviewerServer]
  })

const classify = (
  toolCall: { title?: unknown; kind?: unknown; _meta?: unknown } | undefined,
  overrides: { frameworkId?: string; mcpServerNames?: readonly string[] } = {}
): ReturnType<typeof classifyReviewerToolCall> =>
  classifyReviewerToolCall({
    toolCall,
    frameworkId: (overrides.frameworkId ?? 'opencode') as Parameters<
      typeof classifyReviewerToolCall
    >[0]['frameworkId'],
    mcpServerNames: overrides.mcpServerNames ?? [reviewerServer]
  })

describe('classifyReviewerToolCall', () => {
  it('recognises a reviewer MCP tool by the opencode title spelling', () => {
    expect(classify({ title: `${reviewerServer}_read_turn` })).toEqual({ kind: 'reviewer-mcp' })
  })

  it('recognises a reviewer MCP tool by the claude provider tool name', () => {
    expect(
      classify({
        title: 'read_turn',
        _meta: { claudeCode: { toolName: `mcp__${reviewerServer}__read_turn` } }
      })
    ).toEqual({ kind: 'reviewer-mcp' })
  })

  it('recognises a reviewer MCP tool by the codex title spelling', () => {
    expect(
      classify(
        { title: `mcp.${reviewerServer}.read_turn`, _meta: { toolName: 'read_turn' } },
        { frameworkId: 'codex' }
      )
    ).toEqual({ kind: 'reviewer-mcp' })
  })

  it('takes the reviewer MCP branch even when the call is reported with a reasoning kind', () => {
    // Precedence matters: the reviewer's own tools must never be treated as a native reasoning step,
    // because the MCP branch is what carries the scope check.
    expect(classify({ title: `${reviewerServer}_read_turn`, kind: 'think' })).toEqual({
      kind: 'reviewer-mcp'
    })
  })

  it('classifies ACP kind think as a pure reasoning step', () => {
    expect(classify({ title: 'think', kind: 'think' })).toEqual({ kind: 'pure-reasoning' })
  })

  it('keeps every other native kind foreign — the allowlist is exactly one kind', () => {
    for (const kind of ['execute', 'read', 'fetch', 'edit', 'search', 'switch_mode', 'other']) {
      expect(classify({ title: kind, kind })).toEqual({ kind: 'foreign' })
    }
  })

  it('does not recognise a reviewer tool when the session has more than one MCP server', () => {
    expect(
      classify(
        { title: `${reviewerServer}_read_turn` },
        { mcpServerNames: [reviewerServer, 'purescience_notebook'] }
      )
    ).toEqual({ kind: 'foreign' })
  })

  it('does not recognise a reviewer tool name under a different server', () => {
    expect(classify({ title: 'purescience_notebook_read_turn' })).toEqual({ kind: 'foreign' })
  })
})

describe('decideReviewerPermission', () => {
  it('allows a scope-bounded reviewer MCP call with its own rule name', () => {
    expect(decide({ title: `${reviewerServer}_submit_findings` })).toEqual({
      outcome: 'allow',
      rule: 'reviewer-mcp',
      optionId: 'opt-allow'
    })
  })

  it('allows a reasoning step and names the rule that did it', () => {
    expect(decide({ title: 'thinking about the rubric', kind: 'think' })).toEqual({
      outcome: 'allow',
      rule: 'pure-reasoning-step',
      optionId: 'opt-allow'
    })
  })

  it('rejects a shell call', () => {
    expect(decide({ title: 'bash', kind: 'execute' })).toEqual({
      outcome: 'reject',
      optionId: 'opt-reject'
    })
  })

  it('cancels a reasoning step that has no allow option instead of guessing one', () => {
    // Fail-closed: an approval we cannot express is a cancellation, not an allow.
    expect(
      decide(
        { title: 'think', kind: 'think' },
        { options: [{ optionId: 'opt-reject', kind: 'reject_once' }] }
      )
    ).toEqual({ outcome: 'cancel' })
  })

  it('cancels a reviewer MCP call that has no allow option', () => {
    expect(
      decide(
        { title: `${reviewerServer}_read_artifact` },
        { options: [{ optionId: 'opt-reject', kind: 'reject_once' }] }
      )
    ).toEqual({ outcome: 'cancel' })
  })

  it('rejects a foreign call and still reports it when no reject option exists', () => {
    expect(
      decide(
        { title: 'bash', kind: 'execute' },
        { options: [{ optionId: 'opt-allow', kind: 'allow_once' }] }
      )
    ).toEqual({ outcome: 'reject' })
  })

  it('prefers allow_once over allow_always, and reject_once over reject_always', () => {
    expect(
      decide(
        { title: `${reviewerServer}_read_turn` },
        {
          options: [
            { optionId: 'always-allow', kind: 'allow_always' },
            { optionId: 'once-allow', kind: 'allow_once' }
          ]
        }
      )
    ).toMatchObject({ outcome: 'allow', optionId: 'once-allow' })
    expect(
      decide(
        { title: 'bash', kind: 'execute' },
        {
          options: [
            { optionId: 'always-reject', kind: 'reject_always' },
            { optionId: 'once-reject', kind: 'reject_once' }
          ]
        }
      )
    ).toEqual({ outcome: 'reject', optionId: 'once-reject' })
  })
})

describe('permissionDecisionResponse', () => {
  it('selects the option an allow named', () => {
    expect(
      permissionDecisionResponse({ outcome: 'allow', rule: 'reviewer-mcp', optionId: 'opt-allow' })
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-allow' } })
  })

  it('selects the reject option rather than cancelling when one exists', () => {
    expect(permissionDecisionResponse({ outcome: 'reject', optionId: 'opt-reject' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject' }
    })
  })

  it('cancels a reject that has no option to select, and a cancel', () => {
    expect(permissionDecisionResponse({ outcome: 'reject' })).toEqual({
      outcome: { outcome: 'cancelled' }
    })
    expect(permissionDecisionResponse({ outcome: 'cancel' })).toEqual({
      outcome: { outcome: 'cancelled' }
    })
  })
})
