import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Captures the native Skill tool's input so the app can tell WHICH skill a turn used. The provider's Skill
// activity carries no title, no rawInput and no locations (measured over 81 activities in real sessions), so
// the name has to come from a hook. The hook writes only the tool name and its input for the tools it
// matches; nothing from the conversation is copied.
//
// Failure mode that shapes this file: a PostToolUse hook that exits non-zero BLOCKS the tool call, so the
// capture script is written to swallow every error and the command keeps a shell-level success guard. A
// capture that cannot run must cost nothing.
const HOOK_SUBDIR = 'hooks'
const CAPTURE_FILENAME = 'skill-usage-capture.cjs'
// The filename is the module-owned marker: provisioning prunes any persisted entry whose command references
// it, then re-adds the current one. That keeps the hook declarative across upgrades instead of accumulating
// stale commands, while third-party hooks in the same settings file are never touched.
const CAPTURE_MARKER = CAPTURE_FILENAME
const CAPTURED_TOOL_MATCHER = 'Skill'

const captureLogPath = (configDir: string): string =>
  join(configDir, HOOK_SUBDIR, 'skill-usage-capture.jsonl')

const captureScriptPath = (configDir: string): string =>
  join(configDir, HOOK_SUBDIR, CAPTURE_FILENAME)

// The script itself. Written from source rather than shipped as an asset so the settings entry and the code
// it invokes can never drift apart, and so a packaged app needs no extra resource path.
const captureScript = (logPath: string): string =>
  `// App-owned PostToolUse capture for the native Skill tool (generated; edit the TypeScript source).
// Appends one JSON line per matched tool call, then exits 0 no matter what: a failing PostToolUse hook
// blocks the tool call, and not being able to record a skill name must never break the user's turn.
const fs = require('node:fs')
const path = require('node:path')
const LOG = ${JSON.stringify(logPath)}
try {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'))
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.appendFileSync(
    LOG,
    JSON.stringify({
      hookEventName: payload.hook_event_name,
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
      sessionId: payload.session_id,
      cwd: payload.cwd,
      capturedAt: new Date().toISOString()
    }) + '\\n'
  )
} catch {
  // Deliberately silent: the capture is best-effort, the turn is not.
}
process.stdout.write('{}\\n')
process.exit(0)
`

// POSIX and Windows get different success guards: Claude Code runs hook commands through the platform shell,
// so the "never fail" contract has to be expressed in that shell's own syntax.
const neverFailSuffix = (platform: NodeJS.Platform): string =>
  platform === 'win32' ? ' || exit /b 0' : ' || true'

const quoteCommandPath = (value: string): string => `"${value.replace(/"/g, '\\"')}"`

const skillUsageHookCommand = (configDir: string, platform: NodeJS.Platform): string =>
  `node ${quoteCommandPath(captureScriptPath(configDir))}${neverFailSuffix(platform)}`

const skillUsageHookSettings = (
  configDir: string,
  platform: NodeJS.Platform
): Record<string, unknown> => ({
  PostToolUse: [
    {
      matcher: CAPTURED_TOOL_MATCHER,
      hooks: [{ type: 'command', command: skillUsageHookCommand(configDir, platform) }]
    }
  ]
})

const isSkillUsageHookEntry = (entry: unknown): boolean => {
  if (typeof entry !== 'object' || entry === null) return false
  const hooks = (entry as Record<string, unknown>).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some(
    (hook) =>
      typeof hook === 'object' &&
      hook !== null &&
      typeof (hook as Record<string, unknown>).command === 'string' &&
      ((hook as Record<string, unknown>).command as string).includes(CAPTURE_MARKER)
  )
}

const writeSkillUsageCapture = async (configDir: string): Promise<void> => {
  await mkdir(join(configDir, HOOK_SUBDIR), { recursive: true })
  await writeFile(captureScriptPath(configDir), captureScript(captureLogPath(configDir)), 'utf8')
}

export {
  CAPTURED_TOOL_MATCHER,
  CAPTURE_FILENAME,
  CAPTURE_MARKER,
  HOOK_SUBDIR,
  captureLogPath,
  captureScriptPath,
  isSkillUsageHookEntry,
  skillUsageHookCommand,
  skillUsageHookSettings,
  writeSkillUsageCapture
}
