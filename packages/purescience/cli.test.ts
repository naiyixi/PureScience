import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { PUBLIC_TERMINAL_FIXTURE } from '../../test/fixtures/renderer-contract-certification'
import {
  CliUsageError,
  parseCliArgs,
  reportCliError,
  rollbackCommand,
  runCli,
  runTaskCommand
} from './cli.mjs'

const scratchRoot = (): string => tmpdir()

describe('task CLI', () => {
  it('parses the first milestone run interface', () => {
    expect(
      parseCliArgs([
        'run',
        '--project',
        'systematic-review',
        '--prompt-file',
        'task.md',
        '--session',
        'session-1',
        '--approval-profile',
        'auto',
        '--wait',
        '--json'
      ])
    ).toEqual({
      command: 'run',
      options: {
        open: true,
        json: true,
        jsonl: false,
        wait: true,
        project: 'systematic-review',
        promptFile: 'task.md',
        session: 'session-1',
        approvalProfile: 'auto'
      }
    })
    expect(parseCliArgs(['run', 'status', 'run-1', '--json'])).toEqual({
      command: 'run',
      subcommand: 'status',
      positionals: ['run-1'],
      options: { open: true, json: true, jsonl: false, wait: false }
    })
    expect(
      parseCliArgs([
        'run',
        '--project',
        'project-1',
        '--prompt',
        'Research this.',
        '--wait',
        '--timeout-ms',
        '60000'
      ]).options.timeoutMs
    ).toBe(60_000)
    expect(() => parseCliArgs(['run', '--jsonl'])).toThrow('--jsonl requires run --wait.')
    expect(() => parseCliArgs(['run', '--timeout-ms', '0', '--wait'])).toThrow('Invalid timeout: 0')
    expect(() => parseCliArgs(['run', '--timeout-ms', '1000'])).toThrow(
      '--timeout-ms requires run --wait.'
    )
    expect(
      parseCliArgs([
        'run',
        '--project',
        'project-1',
        '--prompt',
        'Research this.',
        '--session',
        'session-1',
        '--approval-profile',
        'full',
        '--skill',
        'literature-review',
        '--skill',
        'citation-check'
      ])
    ).toMatchObject({
      command: 'run',
      options: {
        session: 'session-1',
        approvalProfile: 'full',
        skills: ['literature-review', 'citation-check']
      }
    })
    expect(() => parseCliArgs(['run', '--approval-profile', 'unsafe'])).toThrow(
      'Invalid approval profile: unsafe'
    )
    expect(() => parseCliArgs(['run', '--json', '--jsonl', '--wait'])).toThrow(
      'Use only one of --json or --jsonl.'
    )
    expect(() => parseCliArgs(['status', '--unknown'])).toThrow('Unknown option: --unknown')
  })

  it('reads a prompt file, waits for completion, and emits one JSON result', async () => {
    const client = {
      startRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'running' }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        output: 'Done',
        artifacts: []
      })
    }
    const log = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          promptFile: 'task.md',
          approvalProfile: 'auto',
          wait: true,
          json: true,
          jsonl: false
        }
      },
      {
        connect: vi.fn().mockResolvedValue(client),
        readFile: vi.fn().mockResolvedValue('Research this.\n'),
        log,
        stdinIsTTY: true
      }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Research this.',
      permissionProfile: 'auto'
    })
    expect(client.waitForRun).toHaveBeenCalledWith('run-1')
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ status: 'completed', output: 'Done' })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('parses and runs the explicit offline rollback command', async () => {
    const parsed = parseCliArgs([
      'rollback-to-0.7.3',
      '--yes',
      '--config-root',
      '/config',
      '--data-root',
      '/data',
      '--output',
      '/rollback'
    ])
    expect(parsed).toEqual({
      command: 'rollback-to-0.7.3',
      options: {
        open: true,
        json: false,
        yes: true,
        configRoot: '/config',
        dataRoot: '/data',
        output: '/rollback'
      }
    })

    const runRollback = vi.fn().mockResolvedValue({
      targetVersion: '0.7.3',
      rollbackDataRoot: '/rollback',
      preservedConfigRoot: '/config.before-rollback',
      preservedDataRoot: '/data',
      sessionsConverted: 4
    })
    const log = vi.fn()
    await rollbackCommand(parsed.options, { runRollback, log })

    expect(runRollback).toHaveBeenCalledWith({
      configRoot: '/config',
      dataRoot: '/data',
      output: '/rollback',
      confirm: true
    })
    expect(log.mock.calls.map(([line]) => line)).toContain(
      'Preserved newer Config Root: /config.before-rollback'
    )
    expect(() => parseCliArgs(['rollback-to-0.7.3'])).not.toThrow()
    expect(() => parseCliArgs(['status', '--yes'])).toThrow('--yes requires rollback-to-0.7.3.')
  })

  // P3-8: the three machine-readable state commands. They must reach the app (not compute anything
  // locally) and print whatever it decided.
  it('dispatches readiness, runtime and connector listings through the SDK', async () => {
    const readiness = { ready: false, checks: [{ id: 'storage', ok: false }] }
    const runtimes = [{ language: 'python', source: 'external', path: '/opt/python' }]
    const connectors = [{ id: 'bio-tools', enabled: false }]
    const client = {
      getReadiness: vi.fn().mockResolvedValue(readiness),
      listRuntimes: vi.fn().mockResolvedValue(runtimes),
      listConnectors: vi.fn().mockResolvedValue(connectors)
    }
    const log = vi.fn()
    const deps = { connect: vi.fn().mockResolvedValue(client), log }

    await runTaskCommand({ command: 'ready', options: { json: true, jsonl: false } }, deps)
    await runTaskCommand(
      { command: 'runtime', subcommand: 'list', options: { json: true, jsonl: false } },
      deps
    )
    await runTaskCommand(
      { command: 'connectors', subcommand: 'list', options: { json: true, jsonl: false } },
      deps
    )

    expect(client.getReadiness).toHaveBeenCalledTimes(1)
    expect(client.listRuntimes).toHaveBeenCalledTimes(1)
    expect(client.listConnectors).toHaveBeenCalledTimes(1)
    const printed = log.mock.calls.map(([line]) => JSON.parse(line))
    expect(printed).toEqual([readiness, runtimes, connectors])
  })

  // The capability catalog is the app's registry, not the CLI's: this command must ask, never decide.
  it('dispatches capability contracts and per-session readiness through the SDK', async () => {
    const capabilities = { declared: [], undeclared: [], problems: [], session: null }
    const client = { getCapabilities: vi.fn().mockResolvedValue(capabilities) }
    const log = vi.fn()
    const deps = { connect: vi.fn().mockResolvedValue(client), log }

    await runTaskCommand({ command: 'capabilities', options: { json: true, jsonl: false } }, deps)
    await runTaskCommand(
      { command: 'capabilities', options: { json: true, jsonl: false, session: 'session-1' } },
      deps
    )

    expect(client.getCapabilities.mock.calls).toEqual([[undefined], ['session-1']])
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([capabilities, capabilities])
  })

  it('dispatches project, session, and artifact commands through the SDK', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Research' }]),
      createProject: vi.fn().mockResolvedValue({ id: 'project-2', name: 'Created' }),
      getSession: vi.fn().mockResolvedValue({ id: 'session-1', status: 'idle' }),
      getRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'completed' }),
      listArtifacts: vi.fn().mockResolvedValue([{ id: 'artifact-1', name: 'report.md' }]),
      downloadArtifact: vi.fn().mockResolvedValue(new Response('report'))
    }
    const connect = vi.fn().mockResolvedValue(client)
    const log = vi.fn()
    const writeDownload = vi.fn().mockResolvedValue(undefined)
    const deps = { connect, log, writeDownload }

    await runTaskCommand(
      { command: 'project', subcommand: 'list', options: { json: true, jsonl: false } },
      deps
    )
    await runTaskCommand(
      {
        command: 'project',
        subcommand: 'create',
        positionals: ['Created'],
        options: { json: true, jsonl: false }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'session',
        subcommand: 'status',
        positionals: ['session-1'],
        options: { json: true, jsonl: false }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'run',
        subcommand: 'status',
        positionals: ['run-1'],
        options: { json: true, jsonl: false }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'artifacts',
        subcommand: 'list',
        positionals: ['session-1'],
        options: { json: true, jsonl: false }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'artifacts',
        subcommand: 'download',
        positionals: ['artifact-1'],
        options: { output: 'report.md', json: true, jsonl: false }
      },
      deps
    )

    expect(client.createProject).toHaveBeenCalledWith({ name: 'Created', description: undefined })
    expect(client.getSession).toHaveBeenCalledWith('session-1')
    expect(client.getRun).toHaveBeenCalledWith('run-1')
    expect(client.listArtifacts).toHaveBeenCalledWith('session-1')
    expect(client.downloadArtifact).toHaveBeenCalledWith('artifact-1')
    expect(writeDownload).toHaveBeenCalledWith(expect.any(Response), 'report.md')
  })

  it('parses the package verbs as a group with their own destination flag', () => {
    expect(
      parseCliArgs(['package', 'export', 'session-1', '--out', '/tmp/p.science'])
    ).toMatchObject({
      command: 'package',
      subcommand: 'export',
      positionals: ['session-1'],
      options: { out: '/tmp/p.science' }
    })
    expect(
      parseCliArgs(['package', 'import', '/tmp/p.science', '--project', 'research', '--json'])
    ).toMatchObject({
      command: 'package',
      subcommand: 'import',
      positionals: ['/tmp/p.science'],
      options: { project: 'research', json: true }
    })
  })

  it('writes the exported package where --out says and reports its own bytes and digest', async () => {
    const directory = await mkdtemp(join(scratchRoot(), 'purescience-cli-package-'))
    const output = join(directory, 'session.science')
    const client = {
      downloadSessionPackage: vi.fn().mockResolvedValue(new Response('PK-package-bytes'))
    }
    const log = vi.fn()
    // The real download path streams the response to the file, then the verb reads that file back: the
    // numbers it prints are the bytes on disk, not the bytes the response claimed.
    const writeDownload = vi.fn(async (response: Response, destination: string) => {
      await writeFile(destination, Buffer.from(await response.arrayBuffer()))
    })

    await runTaskCommand(
      {
        command: 'package',
        subcommand: 'export',
        positionals: ['session-1'],
        options: { out: output, mode: 'full', project: 'research', json: true, jsonl: false }
      },
      { connect: vi.fn().mockResolvedValue(client), log, writeDownload }
    )

    expect(client.downloadSessionPackage).toHaveBeenCalledWith('session-1', {
      mode: 'full',
      projectId: 'research'
    })
    const reported = JSON.parse(log.mock.calls[0][0])
    const onDisk = await readFile(output)
    expect(reported).toEqual({
      sessionId: 'session-1',
      output,
      mode: 'full',
      bytes: onDisk.byteLength,
      sha256: createHash('sha256').update(onDisk).digest('hex')
    })
    await rm(directory, { recursive: true, force: true })
  })

  it('maps a package refusal to exit 2 and a transport failure to exit 3', async () => {
    const refusal = Object.assign(new Error('Session not found: gone'), {
      code: 'session-not-found',
      status: 404
    })
    const refusing = {
      downloadSessionPackage: vi.fn().mockRejectedValue(refusal),
      importSessionPackage: vi.fn().mockRejectedValue(refusal)
    }
    const unreachable = {
      downloadSessionPackage: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
      importSessionPackage: vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    }
    const directory = await mkdtemp(join(scratchRoot(), 'purescience-cli-package-'))
    const packagePath = join(directory, 'in.science')
    await writeFile(packagePath, 'PK')

    await expect(
      runTaskCommand(
        {
          command: 'package',
          subcommand: 'export',
          positionals: ['gone'],
          options: { out: join(directory, 'out.science'), json: true, jsonl: false }
        },
        { connect: vi.fn().mockResolvedValue(refusing), log: vi.fn(), writeDownload: vi.fn() }
      )
    ).rejects.toMatchObject({ exitCode: 2, code: 'session-not-found' })

    await expect(
      runTaskCommand(
        {
          command: 'package',
          subcommand: 'import',
          positionals: [packagePath],
          options: { json: true, jsonl: false }
        },
        { connect: vi.fn().mockResolvedValue(refusing), log: vi.fn() }
      )
    ).rejects.toMatchObject({ exitCode: 2 })

    await expect(
      runTaskCommand(
        {
          command: 'package',
          subcommand: 'import',
          positionals: [packagePath],
          options: { json: true, jsonl: false }
        },
        { connect: vi.fn().mockResolvedValue(unreachable), log: vi.fn() }
      )
    ).rejects.toMatchObject({ exitCode: 3, code: 'package_transport_failed' })
    await rm(directory, { recursive: true, force: true })
  })

  it('imports a package by handing its bytes to the app', async () => {
    const directory = await mkdtemp(join(scratchRoot(), 'purescience-cli-package-'))
    const packagePath = join(directory, 'in.science')
    await writeFile(packagePath, 'PK-package-bytes')
    const client = {
      importSessionPackage: vi.fn().mockResolvedValue({
        ok: true,
        sessionId: 'imported-1',
        posture: { readOnly: true },
        notes: [],
        landed: { citations: 0, reviews: 0, reviewFindings: 0, verificationRecords: 0, skipped: [] }
      })
    }
    const log = vi.fn()

    await runTaskCommand(
      {
        command: 'package',
        subcommand: 'import',
        positionals: [packagePath],
        options: { project: 'research', json: true, jsonl: false }
      },
      { connect: vi.fn().mockResolvedValue(client), log }
    )

    const [sentBytes, sentOptions] = client.importSessionPackage.mock.calls[0]
    expect(Buffer.from(sentBytes).toString()).toBe('PK-package-bytes')
    expect(sentOptions).toEqual({ projectId: 'research' })
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ ok: true, sessionId: 'imported-1' })
    await rm(directory, { recursive: true, force: true })
  })

  it('reads stdin, emits JSONL events, and sets a failed-run exit code', async () => {
    const client = {
      events: async function* () {
        yield PUBLIC_TERMINAL_FIXTURE
      },
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'failed',
        error: 'Provider failed',
        artifacts: []
      })
    }
    const log = vi.fn()
    const setExitCode = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          wait: true,
          json: false,
          jsonl: true
        }
      },
      {
        connect: vi.fn().mockResolvedValue(client),
        readStdin: vi.fn().mockResolvedValue('Research from stdin.\n'),
        stdinIsTTY: false,
        log,
        setExitCode
      }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Research from stdin.'
    })
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      PUBLIC_TERMINAL_FIXTURE,
      expect.objectContaining({ id: 'run-1', status: 'failed' })
    ])
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it('keeps run --session on the stable app id for Task API calls and events', async () => {
    const stableSessionId = 'stable-app-session'
    const providerSessionId = 'provider-session'
    const stableEvent = {
      type: 'run.event',
      data: { sessionId: stableSessionId, kind: 'tool' }
    }
    const client = {
      events: async function* () {
        yield { type: 'run.event', data: { sessionId: providerSessionId, kind: 'tool' } }
        yield stableEvent
      },
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: stableSessionId,
        status: 'running'
      }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: stableSessionId,
        status: 'completed',
        output: 'Done',
        artifacts: []
      })
    }
    const log = vi.fn()

    await runTaskCommand(
      parseCliArgs([
        'run',
        '--project',
        'project-1',
        '--session',
        stableSessionId,
        '--prompt',
        'Continue research.',
        '--wait',
        '--jsonl'
      ]),
      { connect: vi.fn().mockResolvedValue(client), stdinIsTTY: true, log }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Continue research.',
      sessionId: stableSessionId
    })
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      stableEvent,
      expect.objectContaining({ id: 'run-1', sessionId: stableSessionId, status: 'completed' })
    ])
  })

  it('passes the wait timeout and warns when a run needs approval', async () => {
    const events = async function* (): AsyncGenerator<{
      type: string
      data: { sessionId: string }
    }> {
      yield { type: 'permission.requested', data: { sessionId: 'session-1' } }
    }
    const client = {
      events,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'completed',
        output: 'Done',
        artifacts: []
      })
    }
    const warn = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          prompt: 'Research this.',
          wait: true,
          timeoutMs: 60_000,
          json: false,
          jsonl: false
        }
      },
      {
        connect: vi.fn().mockResolvedValue(client),
        stdinIsTTY: true,
        log: vi.fn(),
        warn
      }
    )

    expect(client.waitForRun).toHaveBeenCalledWith('run-1', { timeoutMs: 60_000 })
    expect(warn).toHaveBeenCalledWith(
      'Run is waiting for approval. Approve the request in PureScience Desktop or the Web UI.'
    )
  })

  it('stops only the CLI event wait when a timeout occurs', async () => {
    const timeout = Object.assign(new Error('Timed out waiting for run run-1.'), {
      code: 'timeout'
    })
    let eventSignal: AbortSignal | undefined
    const events = vi.fn(({ signal }: { signal: AbortSignal }) => {
      eventSignal = signal
      return {
        ready: Promise.resolve(),
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise<IteratorResult<never>>((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => resolve({ value: undefined as never, done: true }),
                  { once: true }
                )
              })
          }
        }
      }
    })
    const client = {
      events,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockRejectedValue(timeout)
    }

    await expect(
      runTaskCommand(
        {
          command: 'run',
          options: {
            project: 'project-1',
            prompt: 'Research this.',
            wait: true,
            timeoutMs: 25,
            json: false,
            jsonl: false
          }
        },
        { connect: vi.fn().mockResolvedValue(client), stdinIsTTY: true }
      )
    ).rejects.toBe(timeout)

    expect(client.waitForRun).toHaveBeenCalledWith('run-1', { timeoutMs: 25 })
    expect(eventSignal?.aborted).toBe(true)
    expect(client).not.toHaveProperty('cancelRun')
  })

  it('keeps capability management surfaces outside the CLI', async () => {
    for (const command of ['permission', 'specialist', 'compute', 'notebook', 'notebook-env']) {
      await expect(runCli([command])).rejects.toThrow(`Unknown command: ${command}`)
    }

    // `runtime list` and `connectors list` are read-only projections of what the app already decided,
    // so they belong in the CLI — but nothing that *manages* either capability does, and a bare name
    // is not a command. Decided with an injected connect so the assertion holds with no backend running
    // (the earlier version depended on the machine's daemon: green where one was up, red on CI).
    for (const argv of [
      ['runtime'],
      ['connectors'],
      ['runtime', 'provision'],
      ['connectors', 'enable'],
      ['compute', 'create']
    ]) {
      await expect(
        runTaskCommand(parseCliArgs(argv), { connect: vi.fn().mockResolvedValue({}) })
      ).rejects.toThrow(/Unknown command/)
    }
  })

  it('emits structured machine errors with stable exit codes', () => {
    const error = vi.fn()
    const setExitCode = vi.fn()

    expect(
      reportCliError(new CliUsageError('--project is required.'), ['run', '--json'], {
        error,
        setExitCode
      })
    ).toBe(2)
    expect(JSON.parse(error.mock.calls[0][0])).toEqual({
      error: { code: 'invalid_cli_usage', message: '--project is required.' },
      exitCode: 2
    })
    expect(setExitCode).toHaveBeenCalledWith(2)

    const cases = [
      { code: 'daemon_unavailable', exitCode: 3 },
      { code: 'project_not_found', exitCode: 4 },
      { code: 'session_not_found', exitCode: 4 },
      { code: 'run_not_found', exitCode: 4 },
      { code: 'artifact_not_found', exitCode: 4 },
      { code: 'timeout', exitCode: 1 },
      { code: 'session_busy', exitCode: 1 },
      { code: 'command_failed', exitCode: 1 }
    ]
    for (const contract of cases) {
      error.mockClear()
      setExitCode.mockClear()
      const failure = Object.assign(new Error(`${contract.code} message`), {
        code: contract.code
      })
      expect(reportCliError(failure, ['run', '--json'], { error, setExitCode })).toBe(
        contract.exitCode
      )
      expect(JSON.parse(error.mock.calls[0][0])).toEqual({
        error: { code: contract.code, message: `${contract.code} message` },
        exitCode: contract.exitCode
      })
      expect(setExitCode).toHaveBeenCalledWith(contract.exitCode)
    }
  })
})
