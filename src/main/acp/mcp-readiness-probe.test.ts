import { EventEmitter } from 'node:events'
import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  MCP_READINESS_PROBE_ENV,
  probeMcpServerReadiness,
  runMcpReadinessProbe,
  shouldProbeMcpReadiness,
  summariseMcpReadiness
} from './mcp-readiness-probe'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { write: vi.fn() }
  kill = vi.fn()
}

const server = (name: string): McpServerStdio => ({
  name,
  command: '/bin/fake',
  args: ['entry.js', `--${name}`],
  env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }]
})

const frame = (body: Record<string, unknown>): string => `${JSON.stringify(body)}\n`

const initializeFrame = (protocolVersion = '2025-06-18'): string =>
  frame({ jsonrpc: '2.0', id: 1, result: { protocolVersion } })

const toolsFrame = (toolNames: readonly string[] = ['a', 'b']): string =>
  frame({
    jsonrpc: '2.0',
    id: 2,
    result: { tools: toolNames.map((name) => ({ name, inputSchema: { type: 'object' } })) }
  })

// The full handshake a real client performs: initialize → tools/list.
const emitHandshake = (child: FakeChild, toolNames: readonly string[] = ['a']): void => {
  child.stdout.emit('data', Buffer.from(initializeFrame()))
  child.stdout.emit('data', Buffer.from(toolsFrame(toolNames)))
}

type SpawnOptions = { env: NodeJS.ProcessEnv; stdio: readonly string[] }

const fakeSpawn = (behaviour: (child: FakeChild) => void): ReturnType<typeof vi.fn> =>
  vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    const child = new FakeChild()
    setImmediate(() => behaviour(child))
    return child
  })

describe('shouldProbeMcpReadiness', () => {
  it('is off unless explicitly enabled', () => {
    expect(shouldProbeMcpReadiness({})).toBe(false)
    expect(shouldProbeMcpReadiness({ [MCP_READINESS_PROBE_ENV]: '0' })).toBe(false)
    expect(shouldProbeMcpReadiness({ [MCP_READINESS_PROBE_ENV]: '1' })).toBe(true)
    expect(shouldProbeMcpReadiness({ [MCP_READINESS_PROBE_ENV]: 'true' })).toBe(true)
  })
})

describe('probeMcpServerReadiness', () => {
  it('runs initialize then tools/list and reports both times', async () => {
    const spawnImpl = fakeSpawn((child) => {
      child.emit('spawn')
      child.stdout.emit('data', Buffer.from(initializeFrame('2024-11-05')))
      child.stdout.emit('data', Buffer.from(toolsFrame(['x', 'y', 'z'])))
    })

    const sample = await probeMcpServerReadiness(server('purescience_memory'), {
      spawnImpl: spawnImpl as never,
      timeoutMs: 1_000
    })

    expect(sample.status).toBe('ready')
    expect(sample.detail).toBe('2024-11-05')
    expect(sample.initializeMs).toBeGreaterThanOrEqual(0)
    expect(sample.toolsMs).toBeGreaterThanOrEqual(sample.initializeMs)
    expect(sample.toolCount).toBe(3)

    const child = spawnImpl.mock.results[0]?.value as FakeChild
    const methods = child.stdin.write.mock.calls.map(
      (call) => (JSON.parse(String(call[0]).trim()) as { method: string }).method
    )
    // `tools/list` before the client's `initialized` notification is a protocol violation.
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(child.kill).toHaveBeenCalled()
  })

  it('merges the server env over the parent env so the child boots as node', async () => {
    const spawnImpl = fakeSpawn((child) => {
      child.emit('spawn')
      emitHandshake(child)
    })

    await probeMcpServerReadiness(server('purescience_plan'), {
      spawnImpl: spawnImpl as never,
      timeoutMs: 1_000
    })

    const options = spawnImpl.mock.calls[0]?.[2] as SpawnOptions
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('reports a child that never answers as timeout, with the stderr tail as the reason', async () => {
    // The listener is attached *after* `spawnImpl` returns, so the stderr must arrive on a later tick
    // (a synchronous emit is lost), while the budget has to be generous enough that a loaded suite cannot
    // expire it first — at 25 ms this case failed once in a 258-file run with `no answer within budget`.
    const spawnImpl = fakeSpawn((child) => {
      child.stderr.emit('data', Buffer.from('Cannot find module ./gone.js'))
    })

    const sample = await probeMcpServerReadiness(server('purescience_figure'), {
      spawnImpl: spawnImpl as never,
      timeoutMs: 400
    })

    expect(sample.status).toBe('timeout')
    expect(sample.initializeMs).toBe(-1)
    expect(sample.toolsMs).toBe(-1)
    expect(sample.detail).toContain('Cannot find module')
    expect((spawnImpl.mock.results[0]?.value as FakeChild).kill).toHaveBeenCalled()
  })

  it('reports an early exit as exited, naming the code', async () => {
    const spawnImpl = fakeSpawn((child) => child.emit('exit', 1))

    const sample = await probeMcpServerReadiness(server('purescience_pdf'), {
      spawnImpl: spawnImpl as never,
      timeoutMs: 1_000
    })

    expect(sample.status).toBe('exited')
    expect(sample.detail).toContain('exited with code 1')
  })

  it('reports a throwing spawn without leaving the promise pending', async () => {
    const sample = await probeMcpServerReadiness(server('purescience_routine'), {
      spawnImpl: (() => {
        throw new Error('spawn ENOENT')
      }) as never,
      timeoutMs: 1_000
    })

    expect(sample.status).toBe('spawn-error')
    expect(sample.detail).toContain('ENOENT')
  })

  it('surfaces an initialize error answer as a failure instead of a ready server', async () => {
    const spawnImpl = fakeSpawn((child) =>
      child.stdout.emit(
        'data',
        Buffer.from(frame({ jsonrpc: '2.0', id: 1, error: { message: 'missing RPC token' } }))
      )
    )

    const sample = await probeMcpServerReadiness(server('purescience_endpoints'), {
      spawnImpl: spawnImpl as never,
      timeoutMs: 1_000
    })

    expect(sample.status).toBe('exited')
    expect(sample.detail).toContain('missing RPC token')
  })

  it('keeps a server that initialized but failed tools/list as ready with no tool count', async () => {
    const spawnImpl = fakeSpawn((child) => {
      child.emit('spawn')
      child.stdout.emit('data', Buffer.from(initializeFrame()))
      child.stdout.emit(
        'data',
        Buffer.from(frame({ jsonrpc: '2.0', id: 2, error: { message: 'boom' } }))
      )
    })

    const sample = await probeMcpServerReadiness(server('purescience_knowledge'), {
      spawnImpl: spawnImpl as never,
      timeoutMs: 1_000
    })

    expect(sample.status).toBe('ready')
    expect(sample.toolCount).toBe(-1)
    expect(sample.detail).toContain('tools/list failed')
  })

  it('ignores non-JSON noise on stdout before the handshake frames', async () => {
    const spawnImpl = fakeSpawn((child) => {
      child.emit('spawn')
      child.stdout.emit('data', Buffer.from('booting...\nnot json\n'))
      setTimeout(() => emitHandshake(child), 10)
    })

    const sample = await probeMcpServerReadiness(server('purescience_host_query'), {
      spawnImpl: spawnImpl as never,
      timeoutMs: 1_000
    })

    expect(sample.status).toBe('ready')
  })
})

describe('runMcpReadinessProbe', () => {
  it('measures serially first, then all at once, and skips http transports', async () => {
    const events: string[] = []
    const spawnImpl = (_command: string, args: readonly string[]): FakeChild => {
      const name = String(args[args.length - 1] ?? '').replace(/^--/u, '')
      events.push(name)
      const child = new FakeChild()
      setImmediate(() => {
        child.emit('spawn')
        emitHandshake(child, ['only'])
      })
      return child
    }
    const httpServer = { name: 'purescience-aggregate', url: 'http://127.0.0.1:9/mcp' }

    const result = await runMcpReadinessProbe(
      [server('purescience_memory'), httpServer as never, server('purescience_plan')],
      { spawnImpl: spawnImpl as never, timeoutMs: 1_000 }
    )

    expect(result.serial).toHaveLength(2)
    expect(result.burst).toHaveLength(2)
    // serial pass spawns one after another (order preserved), then the burst pass spawns both again
    expect(events).toHaveLength(4)
    expect(result.serial.map((sample) => sample.toolCount)).toEqual([1, 1])
  })

  it('returns empty passes when nothing is a stdio server', async () => {
    const result = await runMcpReadinessProbe([
      { name: 'aggregate', url: 'http://127.0.0.1:9/mcp' } as never
    ])

    expect(result).toEqual({ serial: [], burst: [] })
  })
})

describe('summariseMcpReadiness', () => {
  it('ranks by tool-list time and never lets a failed server look fast', () => {
    const summary = summariseMcpReadiness([
      { name: 'a', status: 'ready', spawnMs: 5, initializeMs: 300, toolsMs: 1_100, toolCount: 4 },
      { name: 'b', status: 'ready', spawnMs: 4, initializeMs: 900, toolsMs: 950, toolCount: 2 },
      { name: 'c', status: 'timeout', spawnMs: 6, initializeMs: -1, toolsMs: -1, toolCount: -1 }
    ])

    expect(summary.ready).toBe(2)
    expect(summary.failed).toEqual(['c:timeout'])
    expect(summary.slowest).toBe('c=-1,a=1100,b=950')
  })
})
