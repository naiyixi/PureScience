// One-off verification against the session a real user turn just produced (run, read, then removed):
// does the production extractor turn `session.activities` into named tool calls once an agent actually
// calls an MCP tool? The bundle's toolCalls section was `absent:not-collected` because no fixture agent
// call reaches `session.activities`; this checks the real thing.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractToolCalls } from '../../src/main/trajectory/extract-tool-calls'

const ENABLED = process.env.PURESCIENCE_VERIFY_TOOLCALLS === '1'

describe.runIf(ENABLED)('trajectory tool calls on a real session', () => {
  it('names the MCP tool the agent actually called', async () => {
    const root = join(homedir(), '.purescience', 'sessions')
    const candidates: Array<{ mtime: number; path: string }> = []
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const dir = join(root, project.name)
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.json') || name.endsWith('.summary.json')) continue
        const path = join(dir, name)
        const text = await readFile(path, 'utf8')
        if (!text.includes('mcp__purescience_plan__generate_plan')) continue
        candidates.push({
          mtime: Number((await import('node:fs/promises')).stat(path).then((s) => s.mtimeMs)),
          path
        })
      }
    }

    // The session under test is the one whose activities carry a real MCP tool call.
    expect(candidates.length).toBeGreaterThan(0)
    const newest = candidates.sort((left, right) => right.mtime - left.mtime)[0]!
    const doc = JSON.parse(await readFile(newest.path, 'utf8')) as {
      session?: { conversationGraph?: unknown }
    }
    const graph = doc.session?.conversationGraph as { activities?: unknown[] } | undefined
    expect(Array.isArray(graph?.activities)).toBe(true)

    const extraction = extractToolCalls(graph)
    await writeFile(
      join(process.cwd(), 'docs/bench-runs/2026-10-26-toolcalls-reading.txt'),
      [
        `session=${newest.path.split('/sessions/')[1]}`,
        `activities=${(graph?.activities ?? []).length}`,
        `extracted calls=${extraction.calls.length} unnamed=${extraction.unnamed}`,
        ...extraction.calls.map((call) => {
          // Only the fields the extractor actually emits: this activity carries no status or duration, and
          // the module's rule is to omit what it cannot know rather than print a dash.
          const record = call as unknown as Record<string, unknown>
          return `- ${call.tool} fields=${Object.keys(record).sort().join(',')}`
        }),
        ''
      ].join('\n'),
      'utf8'
    )

    expect(extraction.calls.length).toBeGreaterThan(0)
    expect(
      extraction.calls.some((call) => call.tool === 'mcp__purescience_plan__generate_plan')
    ).toBe(true)
  }, 60_000)
})
