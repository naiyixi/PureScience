import { describe, expect, it, vi } from 'vitest'

import { DELEGATE_TOOLS } from './delegate-tasks'
import type { ToolContext } from '../types'

type DelegateResult = {
  results: Array<{
    index: number
    status: string
    output?: string
    error?: string
  }>
}

const makeContext = (runSubAgent?: ToolContext['runSubAgent']): ToolContext =>
  ({
    fetchJson: vi.fn(),
    fetchText: vi.fn(),
    fetchJsonWithHeaders: vi.fn(),
    postJson: vi.fn(),
    runSubAgent,
    credentials: {}
  }) as unknown as ToolContext

describe('delegate_tasks tool', () => {
  it('registers exactly one delegate tool', () => {
    expect(DELEGATE_TOOLS).toHaveLength(1)
    expect(DELEGATE_TOOLS[0]?.id).toBe('delegate_tasks')
    expect(DELEGATE_TOOLS[0]?.connector).toBe('delegate')
  })

  it('runs all sub-tasks in parallel and returns consolidated outputs', async () => {
    const calls: string[] = []
    const runSubAgent: ToolContext['runSubAgent'] = async ({ prompt }) => {
      calls.push(prompt)
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { output: `answer for ${prompt}` }
    }
    const tool = DELEGATE_TOOLS[0]
    if (!tool?.run) throw new Error('missing run')

    const result = (await tool.run(makeContext(runSubAgent), {
      tasks: [
        { prompt: 'task A' },
        { prompt: 'task B' },
        { prompt: 'task C' }
      ]
    })) as DelegateResult

    expect(result.results).toHaveLength(3)
    expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
    expect(result.results[0]?.output).toBe('answer for task A')
    expect(result.results[1]?.output).toBe('answer for task B')
    expect(result.results[2]?.output).toBe('answer for task C')
  })

  it('reports per-task errors without failing the whole batch', async () => {
    const runSubAgent: ToolContext['runSubAgent'] = async ({ prompt }) => {
      if (prompt === 'task A') throw new Error('boom A')
      return { output: `answer for ${prompt}` }
    }
    const tool = DELEGATE_TOOLS[0]
    if (!tool?.run) throw new Error('missing run')

    const result = (await tool.run(makeContext(runSubAgent), {
      tasks: [{ prompt: 'task A' }, { prompt: 'task B' }]
    })) as DelegateResult

    expect(result.results[0]).toMatchObject({ status: 'error', error: 'boom A' })
    expect(result.results[1]).toMatchObject({ status: 'ok', output: 'answer for task B' })
  })

  it('passes model and completion contract through to the sub-agent', async () => {
    let received: Record<string, unknown> | undefined
    const runSubAgent: ToolContext['runSubAgent'] = async (request) => {
      received = request
      return { output: 'done' }
    }
    const tool = DELEGATE_TOOLS[0]
    if (!tool?.run) throw new Error('missing run')

    await tool.run(makeContext(runSubAgent), {
      tasks: [{ prompt: 'task', model: 'claude-opus', completion_contract: ['answer', 'sources'] }]
    })

    expect(received).toMatchObject({
      prompt: 'task',
      model: 'claude-opus',
      completionContract: ['answer', 'sources']
    })
  })

  it('fails with a clear error when no sub-agent executor is available', async () => {
    const tool = DELEGATE_TOOLS[0]
    if (!tool?.run) throw new Error('missing run')
    await expect(
      tool.run(makeContext(), { tasks: [{ prompt: 'task' }] })
    ).rejects.toThrow('live agent session')
  })

  it('rejects empty task lists and more than 12 tasks', async () => {
    const tool = DELEGATE_TOOLS[0]
    if (!tool?.run) throw new Error('missing run')
    const ctx = makeContext(async () => ({ output: 'ok' }))
    await expect(tool.run(ctx, { tasks: [] })).rejects.toThrow('non-empty')
    const many = Array.from({ length: 13 }, (_, i) => ({ prompt: `t${i}` }))
    await expect(tool.run(ctx, { tasks: many })).rejects.toThrow('at most 12')
  })
})
