// Figure MCP server unit tests: contract surface (server name/arg/env wiring) and tool
// identity, mirroring the pdf MCP server test style.

import { describe, expect, it, vi } from 'vitest'

import {
  FIGURE_MCP_SERVER_ARG,
  FIGURE_MCP_SERVER_NAME,
  FIGURE_REVIEW_TOOL_NAME,
  createFigureMcpServer,
  createFigureMcpServerConfig,
  figureReviewRpcParams,
  figureReviewToolDefinition
} from './figure-mcp-server'
import { reviewFigure } from './figure-review-service'
import {
  FIGURE_RULE_LOG_AXIS_SANITY,
  FIGURE_RULE_SOURCE_ARTIFACT,
  type FigureReviewRequest
} from '../../shared/figure'

describe('figure MCP server contract', () => {
  it('names the server and the tool', () => {
    expect(FIGURE_MCP_SERVER_NAME).toBe('purescience-figure')
    expect(FIGURE_MCP_SERVER_ARG).toBe('--purescience-figure-mcp')
    expect(FIGURE_REVIEW_TOOL_NAME).toBe('figure_review')
  })

  it('registers the tool with its handler wiring', () => {
    const handler = { review: vi.fn(async () => ({ panels: 1, violations: [], clean: true })) }
    const server = createFigureMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    expect(Object.keys(tools)).toHaveLength(1)
    expect(handler.review).not.toHaveBeenCalled()
  })

  it('builds a stdio server config with the figure env', () => {
    const config = createFigureMcpServerConfig({
      command: '/usr/local/bin/purescience',
      entryPath: '/app/out/main/index.js',
      endpoint: 'http://127.0.0.1:8642',
      token: 'tok-123',
      sessionId: 'session-9',
      projectId: 'project-1'
    })
    expect(config.name).toBe('purescience-figure')
    expect(config.args).toEqual(['/app/out/main/index.js', '--purescience-figure-mcp'])
    const env = Object.fromEntries((config.env ?? []).map((entry) => [entry.name, entry.value]))
    expect(env.PURESCIENCE_FIGURE_RPC_ENDPOINT).toBe('http://127.0.0.1:8642')
    expect(env.PURESCIENCE_FIGURE_PROJECT_ID).toBe('project-1')
  })

  it('maps snake_case tool input to the camelCase review request', async () => {
    const handler = {
      review: vi.fn(async () => ({ panels: 1, violations: [], clean: true }))
    }
    const server = createFigureMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    const reviewTool = tools[FIGURE_REVIEW_TOOL_NAME] as {
      handler: (
        input: Record<string, unknown>
      ) => Promise<{ content: { type: string; text: string }[] }>
    }
    await reviewTool.handler({
      figure_note: 'Figure 3',
      panels: [
        {
          id: 'A',
          chart_type: 'bar',
          data_shape: { categorical: true },
          series_count: 3,
          label_count: 6,
          rendered: true
        }
      ]
    })
    const request = (handler.review.mock.calls[0] as unknown[] | undefined)?.[0] as {
      figureNote: string
      panels: Array<{ chartType: string; dataShape: { categorical?: boolean } }>
    }
    expect(request.figureNote).toBe('Figure 3')
    expect(request.panels[0]?.chartType).toBe('bar')
    expect(request.panels[0]?.dataShape.categorical).toBe(true)
  })

  it('exposes the rule-6 and rule-7 panel fields the engine reads', () => {
    // Regression: the agent-facing schema omitted axis_ticks / rendered_image_path /
    // source_script_path / font_pt while the tool description and the session prompt append told
    // the agent to declare log-axis ticks and the shipped .png/.py artifacts. zod strips unknown
    // keys, so the engine could never see them and rules 6 and 7 were unreachable from the agent
    // path — a declared capability that silently did nothing.
    const panelsSchema = (
      figureReviewToolDefinition.inputSchema.panels as unknown as {
        element: { shape: Record<string, unknown> }
      }
    ).element
    expect(Object.keys(panelsSchema.shape)).toEqual(
      expect.arrayContaining(['axis_ticks', 'rendered_image_path', 'source_script_path', 'font_pt'])
    )
  })

  it('carries log-axis ticks and shipped artifacts through to the rule engine', async () => {
    const handler = {
      review: vi.fn(async () => ({ panels: 1, violations: [], clean: true }))
    }
    const server = createFigureMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    const reviewTool = tools[FIGURE_REVIEW_TOOL_NAME] as {
      handler: (input: Record<string, unknown>) => Promise<unknown>
    }
    await reviewTool.handler({
      panels: [
        {
          id: 'A',
          chart_type: 'bar',
          data_shape: { categorical: true },
          label_count: 6,
          rendered: true,
          axis_ticks: [{ axis: 'y', scale: 'log', labels: ['0', '0.05'] }],
          rendered_image_path: '',
          source_script_path: '',
          font_pt: 4
        }
      ]
    })
    const request = (handler.review.mock.calls[0] as unknown[] | undefined)?.[0] as
      FigureReviewRequest | undefined
    expect(request?.panels[0]?.axisTicks).toEqual([
      { axis: 'y', scale: 'log', labels: ['0', '0.05'] }
    ])
    expect(request?.panels[0]?.renderedImagePath).toBe('')
    expect(request?.panels[0]?.fontPt).toBe(4)

    // The mapped request must actually reach the rules (schema → mapper → engine).
    const result = reviewFigure(request?.panels ?? [])
    const rules = result.violations.map((violation) => violation.rule)
    expect(rules).toContain(FIGURE_RULE_LOG_AXIS_SANITY)
    expect(rules).toContain(FIGURE_RULE_SOURCE_ARTIFACT)
    expect(result.clean).toBe(false)
  })

  it('nests the review request under `request` for the RPC gateway contract', () => {
    // Regression: the gateway routes figureReview with { sessionId, projectId, request } and
    // rejects the envelope when `request` is missing — spreading the review flat (the pdf/
    // annotation style) failed every figure_review call at the RPC layer.
    const payload = figureReviewRpcParams('session-9', 'project-1', {
      panels: [{ id: 'A', chartType: 'bar' }],
      figureNote: 'Figure 3'
    })

    expect(payload.sessionId).toBe('session-9')
    expect(payload.projectId).toBe('project-1')
    expect(payload.request).toEqual({
      panels: [{ id: 'A', chartType: 'bar' }],
      figureNote: 'Figure 3'
    })
    // The review args must NOT leak into the envelope's top level (gateway validation fails
    // without the nested `request` object).
    expect('panels' in payload).toBe(false)
    expect('figureNote' in payload).toBe(false)
  })
})
