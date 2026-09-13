import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  captureLogPath,
  captureScriptPath,
  isSkillUsageHookEntry,
  skillUsageHookCommand,
  skillUsageHookSettings,
  writeSkillUsageCapture
} from './skill-usage-hook'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

const makeRoot = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), 'skill-usage-hook-'))
  return root
}

// Runs the generated capture exactly as the hook would, returning the exit code instead of throwing: a
// non-zero exit is the failure this module exists to prevent, so it has to be observable here.
const runCapture = (scriptPath: string, stdin: string): number => {
  try {
    execFileSync(process.execPath, [scriptPath], { input: stdin, timeout: 15_000 })
    return 0
  } catch (error) {
    const status = (error as { status?: number }).status
    return typeof status === 'number' ? status : 1
  }
}

describe('skill usage capture hook', () => {
  it('records the tool name and its input for a matched call', async () => {
    const configDir = await makeRoot()
    await writeSkillUsageCapture(configDir)

    const exitCode = runCapture(
      captureScriptPath(configDir),
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { command: 'mcp-genes' },
        session_id: 'session-1',
        cwd: '/tmp'
      })
    )

    expect(exitCode).toBe(0)
    const lines = (await readFile(captureLogPath(configDir), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      hookEventName: 'PostToolUse',
      toolName: 'Skill',
      toolInput: { command: 'mcp-genes' },
      sessionId: 'session-1'
    })
  })

  it('exits 0 on unreadable input so a failed capture can never block the tool call', async () => {
    const configDir = await makeRoot()
    await writeSkillUsageCapture(configDir)

    expect(runCapture(captureScriptPath(configDir), 'not json at all')).toBe(0)
    // Nothing was recorded and, importantly, the hook did not fail the turn to say so.
    await expect(readFile(captureLogPath(configDir), 'utf8')).rejects.toThrow()
  })

  it('appends rather than replaces, so successive calls all survive', async () => {
    const configDir = await makeRoot()
    await writeSkillUsageCapture(configDir)

    runCapture(
      captureScriptPath(configDir),
      JSON.stringify({ tool_name: 'Skill', tool_input: { command: 'a' } })
    )
    runCapture(
      captureScriptPath(configDir),
      JSON.stringify({ tool_name: 'Skill', tool_input: { command: 'b' } })
    )

    const lines = (await readFile(captureLogPath(configDir), 'utf8')).trim().split('\n')
    expect(lines.map((line) => JSON.parse(line).toolInput.command)).toEqual(['a', 'b'])
  })

  it('keeps the never-fail guard in the shell the hook actually runs under', () => {
    const configDir = '/tmp/config'
    expect(skillUsageHookCommand(configDir, 'darwin')).toMatch(/\|\| true$/)
    expect(skillUsageHookCommand(configDir, 'win32')).toMatch(/\|\| exit \/b 0$/)
    expect(skillUsageHookCommand(configDir, 'darwin')).toContain(captureScriptPath(configDir))
  })

  it('matches only Skill calls, and only the module-owned entry', () => {
    const [entry] = skillUsageHookSettings('/tmp/config', 'darwin').PostToolUse as Array<{
      matcher: string
      hooks: unknown[]
    }>
    expect(entry.matcher).toBe('Skill')
    expect(isSkillUsageHookEntry(entry)).toBe(true)
    // A third-party entry is left alone, including one that hooks the same tool.
    expect(
      isSkillUsageHookEntry({ matcher: 'Skill', hooks: [{ type: 'command', command: 'echo hi' }] })
    ).toBe(false)
    expect(isSkillUsageHookEntry({ matcher: 'Write', hooks: [] })).toBe(false)
    expect(isSkillUsageHookEntry(null)).toBe(false)
  })
})
