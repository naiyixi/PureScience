import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { terminateProcessTree } from './process-tree'

// These tests use REAL processes: the group path's whole point is that it reaches what a `ps` snapshot
// cannot, so a fake child would prove nothing. `process-tree.test.ts` covers the mocked per-pid paths.
const describePosix = process.platform === 'win32' ? describe.skip : describe

const spawned: ChildProcess[] = []

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone, or never a group leader.
      }
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
})

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Spawns a detached node "kernel" that starts the given helper children and keeps running, so it behaves
// like a real kernel tree: a leader plus descendants that outlive a naive direct kill.
const spawnKernelTree = async (
  script: string,
  options: { detached?: boolean } = {}
): Promise<{ child: ChildProcess; lines: string[] }> => {
  const child = spawn(process.execPath, ['-e', script], {
    detached: options.detached ?? true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  spawned.push(child)
  const lines: string[] = []
  child.stdout?.on('data', (chunk: Buffer) => {
    lines.push(
      ...chunk
        .toString()
        .split('\n')
        .filter((line) => line.length > 0)
    )
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  return { child, lines }
}

const waitForLine = async (lines: string[], prefix: string): Promise<string> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const found = lines.find((line) => line.startsWith(prefix))
    if (found) return found
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`the child never reported ${prefix}: ${JSON.stringify(lines)}`)
}

describePosix('terminateProcessTree (posix process group)', () => {
  it('reaps a detached kernel tree with one graceful signal and no SIGKILL escalation', async () => {
    const { child, lines } = await spawnKernelTree(
      [
        "const { spawn } = require('node:child_process')",
        "const first = spawn('sleep', ['60'])",
        "const second = spawn('sleep', ['60'])",
        'process.stdout.write(`children:${first.pid},${second.pid}\\n`)',
        'setInterval(() => {}, 1000)'
      ].join('\n')
    )
    const reported = await waitForLine(lines, 'children:')
    const children = reported
      .replace('children:', '')
      .split(',')
      .map((value) => Number(value))
    expect(children).toHaveLength(2)
    expect(children.every((pid) => pidAlive(pid))).toBe(true)

    const logged: string[] = []
    const result = await terminateProcessTree(
      child,
      undefined,
      { error: (message) => logged.push(message) },
      { processGroup: true }
    )

    expect(result.reaped).toBe(true)
    // The whole point: the graceful pass is enough for a well-behaved tree. An escalation line here means
    // the group signal did not reach the descendants, which is what this path exists to fix.
    expect(logged.filter((line) => line.includes('SIGKILL'))).toEqual([])
    expect(pidAlive(child.pid as number)).toBe(false)
    expect(children.some(pidAlive)).toBe(false)
    expect(groupAlive(child.pid as number)).toBe(false)
  })

  it('leaves nothing behind when the tree forks while teardown is running', async () => {
    // A fork loop is the shape the per-pid path cannot win: every `ps` snapshot is stale by the time the
    // signals go out. The group signal addresses membership at signal time, so the only survivors can be
    // processes forked after it — and those are still in the group the follow-up check looks at.
    const { child } = await spawnKernelTree(
      [
        "const { spawn } = require('node:child_process')",
        "const timer = setInterval(() => spawn('sleep', ['5']), 15)",
        'setTimeout(() => clearInterval(timer), 5000)',
        'setInterval(() => {}, 1000)'
      ].join('\n')
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 200))

    const result = await terminateProcessTree(child, undefined, undefined, { processGroup: true })

    expect(result.reaped).toBe(true)
    expect(groupAlive(child.pid as number)).toBe(false)
  })

  it('reaps an orphan that re-parented away from the leader, which the per-pid path cannot see', async () => {
    // The intermediate shell exits immediately after backgrounding a `sleep`, so the sleep is re-parented to
    // launchd while staying in the kernel's group. Enumerating descendants from the leader's pid therefore
    // never sees it; the leader exits on SIGTERM, the survivor list is empty, and the per-pid path reports
    // `reaped: true` with the helper still running — a false answer the uninstall gate would trust. Group
    // membership does not depend on parentage, which is why this path exists.
    const { child, lines } = await spawnKernelTree(
      [
        "const { spawn } = require('node:child_process')",
        "const shell = spawn('bash', ['-c', 'sleep 60 & echo $!; exit 0'], { stdio: ['ignore', 'pipe', 'ignore'] })",
        "shell.stdout.on('data', (chunk) => process.stdout.write(`orphan:${chunk.toString().trim()}\\n`))",
        'setInterval(() => {}, 1000)'
      ].join('\n')
    )
    const orphanPid = Number((await waitForLine(lines, 'orphan:')).replace('orphan:', ''))
    expect(orphanPid).toBeGreaterThan(0)
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    expect(pidAlive(child.pid as number)).toBe(true)
    expect(pidAlive(orphanPid)).toBe(true)

    const result = await terminateProcessTree(child, undefined, undefined, { processGroup: true })

    expect(result.reaped).toBe(true)
    expect(pidAlive(orphanPid)).toBe(false)
    expect(groupAlive(child.pid as number)).toBe(false)
  })

  it('refuses to signal the group when the child is not its leader, and says so', async () => {
    // A child spawned WITHOUT `detached` shares the app's process group. Signalling -pid there would take
    // down the app, so the flag alone must never be trusted: the kernel's own pgid has the final say.
    const { child } = await spawnKernelTree('setInterval(() => {}, 1000)', { detached: false })
    const logged: string[] = []

    const result = await terminateProcessTree(
      child,
      undefined,
      { error: (message) => logged.push(message) },
      { processGroup: true }
    )

    expect(result.reaped).toBe(true)
    expect(pidAlive(child.pid as number)).toBe(false)
    expect(logged.some((line) => line.includes('does not lead its own process group'))).toBe(true)
  })
})
