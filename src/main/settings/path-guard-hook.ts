import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// App-owned PreToolUse path guard. The agent's own file tools can be fenced with permission deny rules
// (see claude-config-provision), but a *shell* tool call reaches around them: an unbounded
// `find / -iname <name>` reads whatever the machine happens to hold — measured on a real isolated
// instance, it read a same-named file out of a different installation's project tree. Deny rules cannot
// express "everything except these folders", so the fence is a hook: it sees the tool call before it
// runs and refuses one whose path resolves outside the app's own roots.
//
// Failure modes that shape this file, in the same spirit as the skill-usage capture:
//  - This is a PreToolUse hook, so a non-zero exit or a deny decision BLOCKS the agent's call. A guard
//    that cannot read its own roots must therefore not guess: it allows, so a missing or unreadable
//    roots file can never brick a turn. Being wrong in the other direction is a read that the app's own
//    project-scope guard still refuses.
//  - It fences *paths*, not commands. A tool input it cannot parse (no path at all) is allowed, and
//    paths under a system prefix the command needs to run at all (interpreters, libraries, devices,
//    TLS material) are allowed too — otherwise ordinary work would break.
//  - Every refusal names the path and points at the project's own folder, so the agent can correct
//    itself in the same turn instead of retrying blindly.
//
// The decision log beside the script is the evidence surface: each call that parsed to a path is
// appended as one JSON line, so "the guard refused it" is checkable after a real turn.
const HOOK_SUBDIR = 'hooks'
const GUARD_FILENAME = 'path-guard.cjs'
const ROOTS_FILENAME = 'path-guard-roots.json'
const DECISIONS_FILENAME = 'path-guard-decisions.jsonl'

// The filename is the module-owned marker: provisioning prunes any persisted PreToolUse entry that
// references it, then re-adds the current one, so the hook stays declarative across upgrades while
// third-party hooks in the same file are never touched.
const GUARD_MARKER = GUARD_FILENAME

// Tools whose inputs name a path or a search root. Bash is included because it is the tool that walked
// out of scope in the first place.
const GUARDED_TOOL_MATCHER = 'Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep|Bash'

export const pathGuardScriptPath = (configDir: string): string =>
  join(configDir, HOOK_SUBDIR, GUARD_FILENAME)

export const pathGuardRootsPath = (configDir: string): string =>
  join(configDir, HOOK_SUBDIR, ROOTS_FILENAME)

export const pathGuardDecisionsPath = (configDir: string): string =>
  join(configDir, HOOK_SUBDIR, DECISIONS_FILENAME)

// The script itself. Written from source rather than shipped as an asset so the settings entry and the
// code it invokes can never drift apart, and so a packaged app needs no extra resource path.
export const pathGuardScript = (configDir: string): string => {
  const rootsPath = pathGuardRootsPath(configDir)
  const decisionsPath = pathGuardDecisionsPath(configDir)
  const primaryHint = 'the folder your project files live in (the Files panel lists them)'
  return `// App-owned PreToolUse path guard (generated; edit the TypeScript source).
// Refuses a tool call whose path resolves outside this app's own folders. Allows anything it cannot
// read as a path, and allows paths under prefixes a command needs to run at all.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOTS_FILE = ${JSON.stringify(rootsPath)}
const DECISIONS_FILE = ${JSON.stringify(decisionsPath)}
// Prefixes that running a tool needs: interpreters, libraries, devices, TLS material. Deliberately
// narrow — a credential read such as /etc/passwd is still refused, and the system temp dir is NOT here
// (it holds other processes' scratch files; a command that needs it works without spelling an absolute
// path). macOS resolves /etc and /var to /private/…, so both spellings are listed.
const SYSTEM_PREFIXES = [
  '/usr/', '/bin/', '/sbin/', '/opt/', '/dev/', '/System/', '/Library/', '/Applications/',
  '/etc/ssl/', '/private/etc/ssl/', '/etc/hosts', '/private/etc/hosts'
]

const record = (entry) => {
  try {
    fs.mkdirSync(path.dirname(DECISIONS_FILE), { recursive: true })
    fs.appendFileSync(DECISIONS_FILE, JSON.stringify(entry) + '\\n')
  } catch {
    // Recording is evidence, never a gate.
  }
}

const readRoots = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(ROOTS_FILE, 'utf8'))
    const roots = Array.isArray(parsed && parsed.roots) ? parsed.roots : []
    const resolved = roots.filter((r) => r && typeof r === 'string' && r.trim()).map((r) => path.resolve(r))
    // The roots file is the whole authority: no implicit extra root is added here. The system temp dir
    // deliberately is NOT one of them — a command that needs it works without naming an absolute path
    // (and the guard only judges paths a tool input actually spells out), while allowing it would open
    // every other process's scratch files.
    return { roots: resolved.map(realPath), hint: typeof parsed.hint === 'string' ? parsed.hint : '' }
  } catch {
    // No readable roots file: allow (see the module comment). Not being able to load the fence must
    // never break a turn.
    return null
  }
}

// A directory can be spelled two ways — macOS symlinks /tmp to /private/tmp, and a relocated install
// may be reached through a link — so comparing resolved strings alone refused legitimate writes to the
// project while accepting the other spelling. Resolve both sides: the roots, and the target by walking
// up to its deepest existing ancestor (a write target need not exist yet), so a symlink can neither
// hide an outside path nor make an inside path look foreign.
const realPath = (value) => {
  let current = value
  const suffix = []
  for (let i = 0; i < 40; i += 1) {
    try {
      const real = fs.realpathSync.native(current)
      return suffix.length ? path.join(real, ...suffix) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return value
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
  return value
}

const inside = (target, roots) =>
  roots.some((root) => target === root || target.startsWith(root.endsWith('/') ? root : root + '/'))

const looksLikePath = (value) =>
  value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~')

// Absolute, home-relative and parent-escaping tokens written anywhere in a shell command. Quoting and
// KEY=value prefixes are stripped; a bare filename or a flag is not a path and stays out.
const commandPaths = (command) =>
  String(command)
    .split(/\\s+/)
    .map((token) => token.replace(/^['"]+/, '').replace(/['"]+$/, '').replace(/^[A-Za-z_][A-Za-z0-9_]*=/, ''))
    .filter((token) => token && looksLikePath(token))

const targets = (input) => {
  const out = []
  for (const key of ['file_path', 'path', 'notebook_path', 'pattern', 'command']) {
    const value = input ? input[key] : undefined
    if (typeof value !== 'string' || !value.trim()) continue
    if (key === 'command') out.push(...commandPaths(value))
    else if (looksLikePath(value)) out.push(value)
  }
  return out
}

const main = () => {
  let payload
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    return
  }
  const loaded = readRoots()
  if (!loaded) return

  const cwd =
    typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd()
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''

  for (const target of targets(payload.tool_input || {})) {
    const expanded = target.replace(/^~(?=\\/|$)/, os.homedir())
    const absolute = realPath(path.resolve(cwd, expanded))
    if (inside(absolute, loaded.roots)) continue
    if (SYSTEM_PREFIXES.some((prefix) => absolute.startsWith(prefix))) continue

    const reason =
      'Refused: ' + absolute + ' is outside this project scope. Project files are read from the ' +
      'project folder itself (' + (loaded.hint || ${JSON.stringify(primaryHint)}) + '); ' +
      'to reach another folder, ask the user to attach it to the project instead of searching the machine.'
    record({ tool: toolName, target, resolved: absolute, decision: 'deny' })
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason
        }
      })
    )
    return
  }
  record({ tool: toolName, decision: 'allow' })
}

try {
  main()
} catch (error) {
  // A guard that throws must not decide: allow the call and leave the reason behind.
  record({ decision: 'error', message: String(error && error.message) })
}
`
}

// The roots the guard is allowed to reach. Written next to the script on every provisioning pass, so
// the fence always describes the install it belongs to: the data root (projects, artifacts, uploads,
// runtime) and the config root (skills, hooks), plus the system temp dir the guard adds itself.
export const pathGuardRootsFile = (roots: readonly string[], hint?: string): string => {
  const payload: Record<string, unknown> = {
    roots: [...new Set(roots.filter((root) => typeof root === 'string' && root.trim()))]
  }
  if (hint && hint.trim()) payload.hint = hint
  return `${JSON.stringify(payload, null, 2)}\n`
}

// The PreToolUse entry that runs the guard. `|| true` keeps a shell-level failure of the guard itself
// from blocking the call outright (the guard's own deny decision is what refuses).
export const pathGuardHookSettings = (
  configDir: string,
  platform: NodeJS.Platform = process.platform
): Readonly<Record<string, unknown>> => {
  const script = pathGuardScriptPath(configDir)
  const command =
    platform === 'win32' ? `node "${script}" || exit 0` : `node "${script}" 2>/dev/null || true`
  return {
    PreToolUse: [{ matcher: GUARDED_TOOL_MATCHER, hooks: [{ type: 'command', command }] }]
  }
}

// Module-owned marker check: provisioning prunes entries whose command references this filename.
export const isPathGuardHookEntry = (entry: unknown): boolean => {
  if (typeof entry !== 'object' || entry === null) return false
  const hooks = (entry as { hooks?: unknown }).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some((hook) => {
    if (typeof hook !== 'object' || hook === null) return false
    const command = (hook as { command?: unknown }).command
    return typeof command === 'string' && command.includes(GUARD_MARKER)
  })
}

// Writes the guard script and its roots file. Idempotent; safe to call before every spawn.
export const writePathGuard = async (
  configDir: string,
  roots: readonly string[] = [],
  hint?: string
): Promise<void> => {
  await mkdir(join(configDir, HOOK_SUBDIR), { recursive: true })
  await writeFile(pathGuardScriptPath(configDir), pathGuardScript(configDir), 'utf8')
  await writeFile(pathGuardRootsPath(configDir), pathGuardRootsFile(roots, hint), 'utf8')
}

export {
  DECISIONS_FILENAME,
  GUARDED_TOOL_MATCHER,
  GUARD_FILENAME,
  GUARD_MARKER,
  HOOK_SUBDIR,
  ROOTS_FILENAME
}
