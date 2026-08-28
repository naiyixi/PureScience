import type { ToolContext, ToolDescriptor } from '../types'

// Multi-agent orchestration: delegates a batch of independent sub-tasks to fresh agent sessions that
// run in parallel (each with its own model turn loop), then returns the consolidated outputs. This is
// the tool-level counterpart of parallel sub-agents — useful for parallel literature
// reviews, decompose-and-conquer analyses, or anything the main agent would otherwise serialize.
export const DELEGATE_TOOLS: ToolDescriptor[] = [
  {
    id: 'delegate_tasks',
    connector: 'delegate',
    description:
      'Runs multiple independent sub-tasks in PARALLEL as fresh sub-agent sessions and returns the consolidated outputs. Args: tasks (required, array of { prompt, model?, completion_contract? }) — each prompt is an independent sub-agent task (e.g. "Summarize these 3 papers: ..." / "List the advantages and risks of X"); optional model is ACCEPTED but sub-agents currently inherit the app\'s active model; optional completion_contract lists fields the sub-agent must include in its final answer; timeout_ms (optional, default 300000 — per sub-agent wait budget). Returns { results: [ { index, prompt, status: "ok" | "error", output?, error? } ] }. Only available inside a live agent session; plain HTTP/web callers receive an error. Prefer splitting work into genuinely independent sub-tasks — the sub-agents do not share context.',
    input: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string' },
              model: { type: 'string' },
              completion_contract: { type: 'array', items: { type: 'string' } }
            },
            required: ['prompt']
          }
        },
        timeout_ms: { type: 'integer', default: 300000 }
      },
      required: ['tasks']
    },
    required: ['tasks'],
    returns:
      '`{ results: [ { index, prompt, status: "ok" | "error", output?, error? } ] }` — outputs are the sub-agents\' final answers.',
    example:
      'const result = await host.mcp("delegate", "delegate_tasks", {"tasks": [{"prompt": "Summarize paper A"}, {"prompt": "Summarize paper B"}]})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      if (!ctx.runSubAgent) {
        throw new Error(
          'delegate_tasks requires a live agent session (sub-agent executor unavailable in this context)'
        )
      }
      const rawTasks = Array.isArray(a.tasks) ? (a.tasks as unknown[]) : []
      if (rawTasks.length === 0) throw new Error('delegate_tasks requires a non-empty tasks array')
      if (rawTasks.length > 12) {
        throw new Error('delegate_tasks supports at most 12 parallel sub-tasks')
      }
      const timeoutMs = Math.min(
        Math.max(Number(a.timeout_ms ?? 300_000) || 300_000, 1_000),
        1_200_000
      )
      const tasks = rawTasks.map((raw) => {
        const t = (raw ?? {}) as Record<string, unknown>
        const prompt = t.prompt != null ? String(t.prompt).trim() : ''
        if (!prompt) throw new Error('each task requires a non-empty prompt')
        return {
          prompt,
          model: t.model != null ? String(t.model) : undefined,
          completionContract: Array.isArray(t.completion_contract)
            ? (t.completion_contract as unknown[]).map(String)
            : undefined
        }
      })

      const results = await Promise.all(
        tasks.map(async (task, index) => {
          try {
            const outcome = await ctx.runSubAgent?.({
              prompt: task.prompt,
              ...(task.model ? { model: task.model } : {}),
              ...(task.completionContract ? { completionContract: task.completionContract } : {}),
              timeoutMs
            })
            if (!outcome) throw new Error('sub-agent executor returned no outcome')
            if (outcome.error) {
              return { index, prompt: task.prompt, status: 'error' as const, error: outcome.error }
            }
            return { index, prompt: task.prompt, status: 'ok' as const, output: outcome.output }
          } catch (error) {
            return {
              index,
              prompt: task.prompt,
              status: 'error' as const,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        })
      )
      return { results }
    }
  }
]
