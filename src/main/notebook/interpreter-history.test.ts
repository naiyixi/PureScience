// 消失的运行时必须被点名：删掉一个已发现的解释器之后，列表里仍要留着它，并且写清为什么不在了。
//
// 这条用例是照 2026-11-19 在 windows-latest 上跑出来的事实写的：挪走 python.exe 后 /api/v1/runtimes 直接少一条
// （6 条 5 runnable → 5 条 4 runnable），没有任何一句话说清是谁不见了。修法是把「见过但现在找不到」的路径记在
// runtime/interpreter-history.json，并让发现流程把它作为 runnable:false 的一行带回来。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { discoverInterpreters, type DiscoveryDeps } from './environment-discovery'
import { readInterpreterHistory, recordInterpreterHistory } from './interpreter-history'

const runtimeRoot = (): string => mkdtempSync(join(tmpdir(), 'ps-runtime-history-'))

const deps = (
  root: string,
  candidates: { path: string; source: 'catalog' | 'system' }[],
  history?: DiscoveryDeps['history']
): DiscoveryDeps => ({
  candidatePaths: async () => candidates,
  // Only the one live interpreter answers; anything else is "does not run", exactly like a deleted binary.
  probeVersion: async (path) => (path.endsWith('python-alive') ? '3.12.4' : undefined),
  rRunnable: async () => false,
  realpath: (p) => p,
  runtimeRoot: root,
  history
})

describe('interpreter history', () => {
  it('keeps a deleted interpreter in the list, named and not runnable', async () => {
    const root = runtimeRoot()
    const alive = join(root, 'python-alive')
    const gone = join(root, 'python-gone')
    writeFileSync(alive, '')
    // The machine had both earlier: this is what the history file records.
    recordInterpreterHistory(root, 'python', [alive, gone])

    const found = await discoverInterpreters(
      'python',
      deps(root, [{ path: alive, source: 'system' }], {
        read: (language) => readInterpreterHistory(root, language),
        record: (language, paths) => recordInterpreterHistory(root, language, paths)
      })
    )

    expect(found.map((entry) => entry.interpreterPath)).toEqual([alive, gone])
    const missing = found.find((entry) => entry.interpreterPath === gone)
    expect(missing?.runnable).toBe(false)
    // The naming is the whole point: a row without a reason is the behaviour we are fixing.
    expect(missing?.detail).toMatch(/no longer at this path/i)
    expect(missing?.version).toBeUndefined()
  })

  it('does not invent a row for an interpreter it never saw', async () => {
    const root = runtimeRoot()
    const alive = join(root, 'python-alive')
    writeFileSync(alive, '')

    const found = await discoverInterpreters('python', deps(root, [{ path: alive, source: 'system' }]))
    expect(found.map((entry) => entry.interpreterPath)).toEqual([alive])
  })

  it('records only what is runnable now, and drops an entry older than the retention window', () => {
    const root = runtimeRoot()
    const alive = join(root, 'python-alive')
    const gone = join(root, 'python-gone')
    writeFileSync(alive, '')

    // 'python-gone' was seen 60 days ago — past the 30-day window, so it must not resurface.
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000
    writeFileSync(
      join(root, 'interpreter-history.json'),
      JSON.stringify({ python: [{ path: gone, lastSeenAt: old }] })
    )
    expect(readInterpreterHistory(root, 'python')).toEqual([])

    recordInterpreterHistory(root, 'python', [alive])
    expect(readInterpreterHistory(root, 'python')).toEqual([alive])
  })

  it('survives a corrupt history file instead of failing discovery', () => {
    const root = runtimeRoot()
    writeFileSync(join(root, 'interpreter-history.json'), '{ this is not json')
    expect(readInterpreterHistory(root, 'python')).toEqual([])
  })
})
