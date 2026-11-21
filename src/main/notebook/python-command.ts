import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const isPython3Version = (output: string): boolean => /\bPython\s+3(?:\.|\s|$)/i.test(output)

// A resolved Python interpreter invocation: the executable plus any leading args needed to select an
// interpreter (e.g. the Windows `py` launcher needs `-3`).
export type PythonCommand = {
  command: string
  baseArgs: string[]
}

// Ordered interpreter candidates by platform. Windows prefers the `py -3` launcher (the reliable way
// to reach a real CPython, and it sidesteps the Microsoft Store `python3` execution-alias stub), then
// bare `python`, then `python3`. Unix prefers `python3`, then `python`.
const pythonCandidates = (platform: NodeJS.Platform): PythonCommand[] =>
  platform === 'win32'
    ? [
        { command: 'py', baseArgs: ['-3'] },
        { command: 'python', baseArgs: [] },
        { command: 'python3', baseArgs: [] }
      ]
    : [
        { command: 'python3', baseArgs: [] },
        { command: 'python', baseArgs: [] }
      ]

export type ResolvePythonDeps = {
  platform: NodeJS.Platform
  // Returns true when `<command> <baseArgs...> --version` runs successfully.
  probe: (candidate: PythonCommand) => Promise<boolean>
}

// Real `<command> --version` probe. On Windows the check runs through a shell so a shimmed launcher
// still resolves; the `py`/`python` executables run fine without one.
const defaultProbe =
  (platform: NodeJS.Platform) =>
  async ({ command, baseArgs }: PythonCommand): Promise<boolean> => {
    try {
      const { stdout, stderr } = await execFileAsync(command, [...baseArgs, '--version'], {
        timeout: 10_000,
        shell: platform === 'win32',
        windowsHide: true
      })

      return isPython3Version(`${stdout}\n${stderr}`)
    } catch {
      return false
    }
  }

// Finds the first Python interpreter that answers `--version`. Environment setup uses this optional
// result to report Notebook availability without making Python a core startup requirement.
export const findPythonCommand = async (
  deps: Partial<ResolvePythonDeps> = {}
): Promise<PythonCommand | undefined> => {
  const platform = deps.platform ?? process.platform
  const probe = deps.probe ?? defaultProbe(platform)
  const candidates = pythonCandidates(platform)

  for (const candidate of candidates) {
    if (await probe(candidate)) return candidate
  }

  return undefined
}

// Probes a SPECIFIC interpreter invocation (`<command> <baseArgs...> --version`) and returns its
// Python-3 version string, or undefined if it is not a runnable Python 3. Used to VALIDATE a
// user-selected interpreter path before reporting it runnable — existence on disk is not enough
// (it could be python2, or not python at all).
export const probeInterpreterVersion = async (
  command: string,
  baseArgs: string[] = [],
  deps: { platform?: NodeJS.Platform } = {}
): Promise<string | undefined> => {
  const platform = deps.platform ?? process.platform
  try {
    const { stdout, stderr } = await execFileAsync(command, [...baseArgs, '--version'], {
      timeout: 10_000,
      shell: platform === 'win32',
      windowsHide: true
    })
    const output = `${stdout}\n${stderr}`
    // The 3-check stays in front: `parsePythonVersion` happily returns `2.7.18`, and a python2 interpreter
    // must not become "runnable with version 2.7.18".
    return isPython3Version(output) ? parsePythonVersion(output) : undefined
  } catch {
    return undefined
  }
}

// The version TOKEN, not the whole output. An interpreter can print unrelated lines and still be fine: a
// venv created under a DOS 8.3 path (C:\Users\RUNNER~1\…) makes CPython's own `venv` module emit
// "Actual environment location may have moved due to redirects, links or junctions" on stderr — spurious,
// per CPython's tracker (bpo-45337) — and the old `output.replace(/^Python\s+/i, '')` then reported that
// whole warning as the interpreter's version, which made a perfectly good interpreter read as not
// runnable (measured on a Windows runner: runtime-selection).
const PYTHON_VERSION = /\bPython\s+(\d+\.\d+(?:\.\d+)?(?:[a-z]+\d*)?)/i

const parsePythonVersion = (output: string): string | undefined => PYTHON_VERSION.exec(output)?.[1]

export { isPython3Version, parsePythonVersion }

// Resolves the first usable interpreter. Falls back to the platform's preferred command when none
// respond, so Notebook execution still produces a clear ENOENT error rather than silently doing
// nothing if the environment changed after the startup check.
export const resolvePythonCommand = async (
  deps: Partial<ResolvePythonDeps> = {}
): Promise<PythonCommand> => {
  const found = await findPythonCommand(deps)
  if (found) return found

  const platform = deps.platform ?? process.platform
  const candidates = pythonCandidates(platform)

  return candidates[0]
}
