import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  GUARDED_TOOL_MATCHER,
  isPathGuardHookEntry,
  pathGuardDecisionsPath,
  pathGuardHookSettings,
  pathGuardRootsFile,
  pathGuardScriptPath,
  writePathGuard
} from './path-guard-hook'

// Makes a node process report win32 and hand out path.win32, so drive letters, backslashes and case
// folding are exercised on any machine. The generated script is written from a template literal, where a
// backslash typed in the source goes through escape processing a second time: a mistake that is
// invisible in a POSIX run and turns the fence into decoration on Windows.
const WIN_SIMULATION = `const Module = require('node:module')
const path = require('node:path')
const load = Module._load
Module._load = function (request) {
  if (request === 'node:path' || request === 'path') return path.win32
  return load.apply(this, arguments)
}
Object.defineProperty(process, 'platform', { value: 'win32' })
`

let root: string | undefined

const makeRoot = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), 'path-guard-'))
  return root
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

// Runs the generated guard exactly as the hook would. stdout is the decision channel and a non-zero
// exit would block the call on its own, so both are observable here: a guard that cannot parse its
// input must neither refuse nor fail. `preload`/`env` let a test hand it another platform's semantics.
const runGuard = (
  scriptPath: string,
  payload: unknown,
  options: { preload?: string; env?: Record<string, string> } = {}
): { status: number; stdout: string } => {
  const args = options.preload ? ['--require', options.preload, scriptPath] : [scriptPath]
  try {
    const stdout = execFileSync(process.execPath, args, {
      input: JSON.stringify(payload),
      timeout: 15_000,
      encoding: 'utf8',
      env: options.env ? { ...process.env, ...options.env } : process.env
    })
    return { status: 0, stdout: stdout ?? '' }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string }
    return {
      status: typeof failed.status === 'number' ? failed.status : 1,
      stdout: String(failed.stdout ?? '')
    }
  }
}

const decisions = async (configDir: string): Promise<Record<string, unknown>[]> => {
  const text = await readFile(pathGuardDecisionsPath(configDir), 'utf8')
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('agent path guard hook', () => {
  it('refuses the unbounded shell search that walked out of scope on a real instance', async () => {
    const configDir = await makeRoot()
    const dataRoot = join(configDir, 'data')
    await writePathGuard(configDir, [dataRoot], dataRoot)

    const { status, stdout } = runGuard(pathGuardScriptPath(configDir), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'find / -iname "egfr_t790m_merged.csv" -not -path "*/proc/*"'
      },
      cwd: join(dataRoot, 'notebooks', 'project-1')
    })

    // Exit 0: the refusal is the guard's decision, never an accident of the process failing.
    expect(status).toBe(0)
    const decision = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
    }
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain(
      'outside this project scope'
    )
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain(dataRoot)

    const log = await decisions(configDir)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ tool: 'Bash', decision: 'deny' })
    // `/` is the POSIX root and the drive root on Windows: judge it the way the platform resolves it.
    expect((log[0] as { resolved: string }).resolved).toMatch(/^(?:[A-Za-z]:[\\/]|\/)$/)
  })

  it('allows reading a project file inside the roots', async () => {
    const configDir = await makeRoot()
    const dataRoot = join(configDir, 'data')
    await writePathGuard(configDir, [dataRoot], dataRoot)

    const { status, stdout } = runGuard(pathGuardScriptPath(configDir), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(dataRoot, 'notebooks/project-1/uploads/egfr.csv') },
      cwd: join(dataRoot, 'notebooks', 'project-1')
    })

    expect(status).toBe(0)
    expect(stdout).toBe('')
    expect(await decisions(configDir)).toEqual([{ tool: 'Read', decision: 'allow' }])
  })

  it('refuses a credential read outside the roots but allows the system paths a command needs', async () => {
    const configDir = await makeRoot()
    const dataRoot = join(configDir, 'data')
    await writePathGuard(configDir, [dataRoot], dataRoot)
    const script = pathGuardScriptPath(configDir)

    const credential = runGuard(script, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/passwd' },
      cwd: dataRoot
    })
    expect(JSON.parse(credential.stdout).hookSpecificOutput.permissionDecision).toBe('deny')

    // A command needs the platform's own system directories: /usr/bin here, the Windows directory there.
    const systemPath =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
        : '/usr/bin'
    const systemRead = runGuard(script, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `ls "${systemPath}" | head -3` },
      cwd: dataRoot
    })
    expect(systemRead.status).toBe(0)
    expect(systemRead.stdout).toBe('')

    const relative = runGuard(script, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'python3 plot_egfr_ic50.py --out egfr_t790m_ic50.png' },
      cwd: join(dataRoot, 'notebooks', 'project-1')
    })
    expect(relative.status).toBe(0)
    expect(relative.stdout).toBe('')
  })

  it('resolves symlinks so one spelling of a folder is not refused while another is allowed', async (context) => {
    const configDir = await makeRoot()
    const dataRoot = join(configDir, 'data')
    await mkdir(dataRoot, { recursive: true })
    // Windows only creates links with developer mode or elevation; what the guard does on a machine that
    // cannot make one is not what this test claims, so it steps aside rather than reporting a failure.
    try {
      await symlink(dataRoot, join(configDir, 'data-link'))
    } catch {
      context.skip()
      return
    }
    await writePathGuard(configDir, [dataRoot], dataRoot)
    const script = pathGuardScriptPath(configDir)

    const throughLink = runGuard(script, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(configDir, 'data-link', 'guard-check.txt') },
      cwd: configDir
    })
    expect(throughLink.status).toBe(0)
    expect(throughLink.stdout).toBe('')

    // The security direction: a link pointing out of the roots must not become a way out.
    await mkdir(join(configDir, 'outside'), { recursive: true })
    await writeFile(join(configDir, 'outside', 'secret.txt'), 'not for the agent')
    await symlink(join(configDir, 'outside'), join(dataRoot, 'escape'))
    const escaped = runGuard(script, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(dataRoot, 'escape', 'secret.txt') },
      cwd: dataRoot
    })
    expect(JSON.parse(escaped.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('judges Windows drive paths, which a POSIX run cannot see at all', async () => {
    const configDir = await makeRoot()
    const dataRoot = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ps\\data'
    await writePathGuard(configDir, [dataRoot], dataRoot)
    const script = pathGuardScriptPath(configDir)

    const preload = join(configDir, 'win-sim.cjs')
    await writeFile(preload, WIN_SIMULATION)
    const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }
    const run = (payload: unknown): { status: number; stdout: string } =>
      runGuard(script, payload, { preload, env })
    const read = (
      filePath: string
    ): {
      hook_event_name: string
      tool_name: string
      tool_input: { file_path: string }
      cwd: string
    } => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
      cwd: dataRoot
    })

    // A drive path is a path: unjudged, it would leave the fence decorative on Windows.
    const outside = run(read('C:\\Users\\Public\\secret-notes.txt'))
    expect(outside.status).toBe(0)
    expect(JSON.parse(outside.stdout).hookSpecificOutput.permissionDecision).toBe('deny')

    // Inside, including the spelling Windows itself may hand back (case-folded, short names).
    expect(
      run(read('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ps\\data\\notebooks\\a.csv')).stdout
    ).toBe('')
    expect(run(read('c:\\users\\runner~1\\appdata\\local\\temp\\ps\\DATA\\a.csv')).stdout).toBe('')

    // A system directory passes here for the same reason /usr does on POSIX — and it is read from the
    // environment, because the drive letter is whatever the machine uses.
    expect(
      run({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'dir C:\\Windows\\System32' },
        cwd: dataRoot
      }).stdout
    ).toBe('')
  })

  it('refuses a file outside the roots on whichever platform it runs', async () => {
    const configDir = await makeRoot()
    const dataRoot = join(configDir, 'data')
    await writePathGuard(configDir, [dataRoot], dataRoot)

    // The Windows branch is the one that matters there: a drive path that is not recognized as a path
    // would never be judged at all.
    const outside =
      process.platform === 'win32'
        ? 'C:\\Users\\Public\\secret-notes.txt'
        : '/Users/Shared/secret-notes.txt'
    const { status, stdout } = runGuard(pathGuardScriptPath(configDir), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: outside },
      cwd: dataRoot
    })

    expect(status).toBe(0)
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('allows when it cannot read its roots, so an unreadable fence never breaks a turn', async () => {
    const configDir = await makeRoot()
    const dataRoot = join(configDir, 'data')
    await writePathGuard(configDir, [dataRoot], dataRoot)
    // Point the guard at a roots file that is not there: this is the state a manual cleanup can leave
    // behind, and guessing in that state would either brick the agent or allow everything silently.
    await rm(join(configDir, 'hooks', 'path-guard-roots.json'))

    const { status, stdout } = runGuard(pathGuardScriptPath(configDir), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'find / -iname anything.csv' },
      cwd: dataRoot
    })

    expect(status).toBe(0)
    expect(stdout).toBe('')
  })

  it('ignores a tool call that carries no path at all', async () => {
    const configDir = await makeRoot()
    await writePathGuard(configDir, [join(configDir, 'data')], configDir)

    const { status, stdout } = runGuard(pathGuardScriptPath(configDir), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status --short' },
      cwd: configDir
    })

    expect(status).toBe(0)
    expect(stdout).toBe('')
  })

  it('does not read shell punctuation as part of the path', async () => {
    const configDir = await makeRoot()
    const dataRoot = join(configDir, 'data')
    await writePathGuard(configDir, [dataRoot], dataRoot)
    const script = pathGuardScriptPath(configDir)

    // Measured on a real machine: a command that changed into the install's own root and listed it was
    // refused, with the decision recorded against that root plus a trailing semicolon — the app's own
    // folder, one character off. The location the command names is the root itself, which is in scope.
    const inside = runGuard(script, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `cd ${dataRoot}; ls -la; echo done` },
      cwd: dataRoot
    })
    expect(inside.status).toBe(0)
    expect(inside.stdout).toBe('')

    // The separator must not become a way out either: the same shape pointing outside is still refused,
    // and the log names the location rather than the punctuation-carrying spelling of it.
    const outside = join(configDir, 'outside')
    await mkdir(outside, { recursive: true })
    const refused = runGuard(script, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `cd ${outside}; ls` },
      cwd: dataRoot
    })
    expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    expect((await decisions(configDir)).at(-1)).toMatchObject({
      tool: 'Bash',
      decision: 'deny',
      target: outside
    })
  })

  it('reads a regular-expression program as a pattern, not as a location', async () => {
    const configDir = await makeRoot()
    const dataRoot = join(configDir, 'data')
    await mkdir(join(dataRoot, 'notebooks'), { recursive: true })
    await writePathGuard(configDir, [dataRoot], dataRoot)
    const script = pathGuardScriptPath(configDir)
    const run = (command: string): { status: number; stdout: string } =>
      runGuard(script, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        cwd: join(dataRoot, 'notebooks')
      })

    // The real refusal: a quoted awk program anchored with a caret was judged as the disk root, so an
    // ordinary structure-cleaning command was refused.
    expect(run(`awk '/^ATOM|^HETATM/{print}' receptor.pdb > clean.pdb`).stdout).toBe('')

    // The carve-out must not become a detector bypass: a glob is a real search of a real directory and
    // stays fenced, and a pattern beside an outside path does not hide it.
    const outside = join(configDir, 'outside')
    await mkdir(outside, { recursive: true })
    expect(JSON.parse(run(`find ${join(outside, '*')} -iname '*.pdb'`).stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' }
    })
    expect(
      JSON.parse(run(`awk '/^ATOM/{print}' ${join(outside, 'secret.pdb')}`).stdout)
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })

    // The same class reaches the file tools: a search pattern is spelled in the Grep tool's own field,
    // and a caret-anchored one was judged as a location there too.
    expect(
      runGuard(script, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: '/^ATOM/' },
        cwd: join(dataRoot, 'notebooks')
      }).stdout
    ).toBe('')
    expect(
      JSON.parse(
        runGuard(script, {
          hook_event_name: 'PreToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: '/^ATOM/', path: outside },
          cwd: join(dataRoot, 'notebooks')
        }).stdout
      )
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('reaches the model-weight caches a notebook runtime downloads into, and nothing wider', async () => {
    const configDir = await makeRoot()
    const dataRoot = join(configDir, 'data')
    await writePathGuard(configDir, [dataRoot], dataRoot)
    const script = pathGuardScriptPath(configDir)
    const bash = (command: string): { status: number; stdout: string } =>
      runGuard(script, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        cwd: dataRoot
      })

    // Measured on a real machine: a running ESM2/ProteinMPNN job had these two refused.
    expect(bash('du -sh ~/.cache/torch/hub/checkpoints/').stdout).toBe('')
    expect(bash('ls -la ~/.cache/huggingface/hub').stdout).toBe('')

    // The list is literal namespaces, never a wildcard over the cache directory: a sibling cache in the
    // same parent stays refused, as does a read of anything else under it.
    expect(JSON.parse(bash('ls ~/.cache/other-tool/data').stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' }
    })
    expect(
      JSON.parse(
        runGuard(script, {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: join(homedir(), '.cache', 'other-tool', 'data.csv') },
          cwd: dataRoot
        }).stdout
      )
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })

    // A weights file read through the named namespace is allowed, on every platform the guard runs on.
    expect(
      runGuard(script, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: {
          file_path: join(homedir(), '.cache', 'huggingface', 'hub', 'models--x', 'config.json')
        },
        cwd: dataRoot
      }).stdout
    ).toBe('')
  })

  it('writes the roots file the guard enforces, and the entry that runs it', async () => {
    const configDir = await makeRoot()
    await writePathGuard(configDir, [join(configDir, 'data'), configDir], join(configDir, 'data'))

    const roots = JSON.parse(
      await readFile(join(configDir, 'hooks', 'path-guard-roots.json'), 'utf8')
    ) as { roots: string[]; hint: string }
    expect(roots.roots).toEqual([join(configDir, 'data'), configDir])
    expect(roots.hint).toBe(join(configDir, 'data'))

    const settings = pathGuardHookSettings(configDir, 'darwin') as {
      PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[]
    }
    expect(settings.PreToolUse).toHaveLength(1)
    expect(settings.PreToolUse[0].matcher).toBe(GUARDED_TOOL_MATCHER)
    expect(settings.PreToolUse[0].hooks[0].command).toContain('path-guard.cjs')
    expect(settings.PreToolUse[0].hooks[0].command).toContain('|| true')
    expect(isPathGuardHookEntry(settings.PreToolUse[0])).toBe(true)
    expect(isPathGuardHookEntry({ matcher: 'Bash', hooks: [{ command: 'node other.cjs' }] })).toBe(
      false
    )
  })

  it('generates a script that parses, so a template-escaping mistake cannot ship', async () => {
    const configDir = await makeRoot()
    await writePathGuard(configDir, [join(configDir, 'data')])

    // `node --check` parses without running. The script is generated from a template literal, where a
    // stray escape (an unescaped `/` inside a regex, say) produces code Node refuses to load — and the
    // hook would then fail on every tool call instead of refusing the ones that go out of scope.
    expect(() =>
      execFileSync(process.execPath, ['--check', pathGuardScriptPath(configDir)], {
        encoding: 'utf8'
      })
    ).not.toThrow()
  })

  it('serializes only usable roots', () => {
    const file = pathGuardRootsFile(['/a', '  ', '/a', '/b'], '/a')
    expect(JSON.parse(file)).toEqual({ roots: ['/a', '/b'], hint: '/a' })
  })
})
