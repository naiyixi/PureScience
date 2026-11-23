import { expect } from '@playwright/test'
import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// The two reads that could not be shown from outside until now: `session_activity`'s `running`, and
// `list_schedules` seeing a schedule the app really holds.
//
// Why a separate spec: the other external-client spec proves the tool table, the disk agreement and the
// approval card, and it does that on a settled session — which is exactly the state in which `running` is
// always 0. The only honest way to observe `running: 1` is to have a turn genuinely in flight while the
// outside client asks, so this spec starts the fixture's hanging turn and asks from outside.
//
// The control matters as much as the assertion: `running` is read *before* anything is sent and must be 0.
// A judgement that can only ever return "≥ 1" would pass on a constant.

const CLI_PATH = resolve(process.cwd(), 'packages', 'purescience', 'cli.mjs')
// The fixture leaves a turn hanging on this exact prompt (it streams one line, then never finishes). It
// keys the "already hanging" state by file in tmpdir so the state survives an app restart; a leftover file
// from an earlier run would make this turn answer immediately, so it is removed first.
const HANGING_PROMPT = 'Continue the interrupted turn fixture.'

test.setTimeout(240_000)

// The fixture keys "this turn is already hanging" by file in tmpdir, so the state outlives an app restart.
// A leftover file from an earlier run turns the hanging turn into an answered one; this spec is the one that
// leaves such a file behind on purpose, so it owns the cleanup.
const clearHangingMarkers = async (): Promise<void> => {
  for (const entry of await readdir(tmpdir())) {
    if (entry.startsWith('purescience-e2e-interrupted-turn-')) {
      await rm(join(tmpdir(), entry), { force: true })
    }
  }
}

type ToolPayload = Record<string, unknown>

const payloadOf = (result: unknown): ToolPayload => {
  const value = result as { content?: { type?: string; text?: string }[] }
  const content = Array.isArray(value.content) ? value.content : []
  return JSON.parse(content.map((entry) => entry.text ?? '').join('')) as ToolPayload
}

test('a turn that is really in flight reads as running, and a schedule the app holds reads from outside', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Activity MCP')

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, 'mcp', '--config-root', app.storageRoot],
    stderr: 'inherit'
  })
  const client = new Client({ name: 'purescience-activity-client', version: '1.0.0' })
  await client.connect(transport)

  try {
    // Control reading: the project exists and has a session, but nothing has been sent.
    const before = payloadOf(
      await client.callTool({ name: 'session_activity', arguments: { project: projectId } })
    )
    console.log(`[f2] before the turn: ${JSON.stringify(before)}`)
    expect(before.projectId).toBe(projectId)
    expect(Number(before.running)).toBe(0)

    // Deterministic: a marker left by an earlier run (same session ids, same tmpdir) would make the fixture
    // answer at once instead of hanging. The id is not known yet — the session is created by the first send —
    // so the stale state is cleared by name pattern rather than by id.
    // `workers: 1` in playwright.config, so no other spec is holding a hanging turn while this runs: the
    // markers can be cleared outright. They are cleared again in `finally`, because this spec deliberately
    // leaves its turn hanging and that marker would otherwise make the *next* run answer at once — which is
    // exactly the failure that made the first version of this spec flaky.
    await clearHangingMarkers()

    await page.getByRole('textbox', { name: 'Ask anything' }).fill(HANGING_PROMPT)
    await page.getByRole('button', { name: 'Send message' }).click()

    let inFlight: ToolPayload = {}
    await expect
      .poll(
        async () => {
          inFlight = payloadOf(
            await client.callTool({ name: 'session_activity', arguments: { project: projectId } })
          )
          return Number(inFlight.running)
        },
        { timeout: 120_000, message: 'the hanging turn shows up as running for an outside client' }
      )
      .toBeGreaterThanOrEqual(1)
    console.log(`[f2] in flight: ${JSON.stringify(inFlight)}`)
    const inFlightRows = (inFlight.sessions ?? []) as { id: string; status: string }[]
    const runningRow = inFlightRows.find((row) => row.status === 'running')
    expect(runningRow).toBeDefined()

    // The id the outside client sees must be the id the app itself holds — read from the app's own catalog,
    // so a tool answering with a fabricated id could not satisfy both sides.
    const sessionId = await page.evaluate(async (id) => {
      const bridge = globalThis as unknown as {
        api: {
          sessions: {
            listCatalog: () => Promise<{ sessions?: { id: string; projectId: string }[] }>
          }
        }
      }
      const catalog = await bridge.api.sessions.listCatalog()
      const rows = (catalog.sessions ?? []).filter((session) => session.projectId === id)
      return rows[rows.length - 1]?.id
    }, projectId)
    expect(typeof sessionId).toBe('string')
    expect(runningRow?.id).toBe(sessionId)

    // A schedule the app itself accepted, read back from outside. Created through the same API the
    // settings panel uses, so this is not a store written by the test.
    const created = await page.evaluate(
      async ({ sessionId: owner }) => {
        const bridge = globalThis as unknown as {
          api: { routine: { upsert: (request: unknown) => Promise<unknown> } }
        }
        // The IPC answers with the schedule itself. `RoutineConfigureResult` (the `{ schedule }` envelope) is
        // the routine **MCP server**'s shape, a different surface — reading `.schedule` here would be reading
        // a type that this channel never promised.
        return (await bridge.api.routine.upsert({
          sessionId: owner,
          configure: {
            everyMinutes: 30,
            instruction: 'Poll the trial registry.',
            label: 'mcp activity drill'
          }
        })) as { id: string }
      },
      { sessionId }
    )
    console.log(`[f2] created schedule: ${JSON.stringify(created)}`)

    const schedules = payloadOf(await client.callTool({ name: 'list_schedules', arguments: {} }))
    console.log(`[f2] list_schedules: ${JSON.stringify(schedules)}`)
    expect(Number(schedules.total)).toBeGreaterThanOrEqual(1)
    const listed = (schedules.schedules ?? []) as {
      id: string
      label: string | null
      everyMinutes: number
      enabled: boolean
      nextDue: number | null
    }[]
    const mine = listed.find((schedule) => schedule.id === created.id)
    expect(mine).toBeDefined()
    expect(mine?.label).toBe('mcp activity drill')
    expect(mine?.everyMinutes).toBe(30)
    expect(mine?.enabled).toBe(true)
    // A paused routine has no next due time; this one is enabled, so it must carry a real timestamp rather
    // than `null` — "enabled but never due" would be the shape of a scheduler that is not running.
    expect(typeof mine?.nextDue).toBe('number')
  } finally {
    await client.close()
    await clearHangingMarkers()
  }
})
