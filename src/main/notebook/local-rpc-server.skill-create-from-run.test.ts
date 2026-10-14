// 端到端：一条被记录的方法 → 可调用的技能。这条链的每一环都是产品自己的实现（真实的本地 RPC 通道、
// 真实的运行记录仓储、真实的编译器、真实的 `SkillCreator` 写入者），只有数据根与配置根是隔离的
// 临时目录 —— 所以读数落地的是盘上的真文件，而不是替身。
//
// 记录由**应用自己的仓储**写出来（`appendRun`），不手搓 run.json：手搓的夹具会绕过路径编码、
// 归一化与校验，于是「来源层读得懂真实记录」这件事根本没被验到。
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { SkillCreator } from '../skills/skill-creator'
import { createMethodSkillCompiler } from '../skills/method-skill-compiler'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { NotebookRunRepository } from './repository'

const SCRIPT = [
  'import pandas as pd',
  'frame = pd.read_csv("data/input.csv")',
  'frame.dropna().to_csv("data/clean.csv", index=False)',
  'print(len(frame))'
].join('\n')

const recordedRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-7',
  cellId: 'cell-2',
  source: 'agent',
  kernelKind: 'python',
  script: SCRIPT,
  status: 'completed',
  startedAt: 1_700_000_000_000,
  executionCount: 1,
  text: { stdout: '128\n', stderr: '', traceback: '', plain: ['128'] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

let server: NotebookLocalRpcServer | undefined
const temporary: string[] = []

const makeDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

afterEach(async () => {
  await server?.close()
  server = undefined
  while (temporary.length > 0) await rm(temporary.pop()!, { recursive: true, force: true })
})

describe('skillCreate from a recorded run, over the server own transport', () => {
  const start = async (): Promise<{
    post: (params: Record<string, unknown>) => Promise<Response>
    configDir: string
  }> => {
    const dataRoot = await makeDir('ps-runs-')
    const configDir = await makeDir('ps-skills-')
    const repository = new NotebookRunRepository(dataRoot)
    await repository.loadOrCreate({
      projectName: 'p1',
      sessionId: 'session-1',
      workspaceCwd: '/tmp/workspace'
    })
    await repository.appendRun({ projectName: 'p1', sessionId: 'session-1', run: recordedRun() })

    const skillCreator = new SkillCreator({ configDir })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      token: 'secret-token',
      skillCreator,
      skillMethodCompiler: createMethodSkillCompiler({
        skillCreator,
        repository,
        listProjectIds: async () => ['p1']
      })
    })
    server.registerSessionAlias('pre-session-alias', 'session-1')
    const { endpoint, token } = await server.issueSkillImportConnection('pre-session-alias')

    return {
      configDir,
      post: (params) =>
        fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'skillCreate', params })
        })
    }
  }

  it('writes a skill whose body is the recorded script, read back from disk', async () => {
    const { post, configDir } = await start()

    const response = await post({
      sessionId: 'pre-session-alias',
      name: 'clean-frame',
      fromRunId: 'run-7'
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      result: { state: string; fingerprint: string; projectId: string; runId: string; kind: string }
    }
    expect(payload.result).toMatchObject({
      state: 'created',
      projectId: 'p1',
      runId: 'run-7',
      kind: 'procedure'
    })
    expect(payload.result.fingerprint).toMatch(/^method-skill:v1-/)
    // 指纹要能被第三方按发布出去的配方重算，所以它必须出现在盘上的文档里，而不只活在响应里。
    const document = await readFile(join(configDir, 'skills', 'clean-frame', 'SKILL.md'), 'utf8')
    expect(document).toContain(SCRIPT)
    expect(document).toContain('trust_origin: "run-7"')
    expect(document).toContain('run: run-7')
    expect(document).toContain(payload.result.fingerprint)
    // 唯一被写入的是这一份文档。
    expect(await readdir(configDir)).toEqual(['skills'])
    expect(await readdir(join(configDir, 'skills'))).toEqual(['clean-frame'])
  })

  it('refuses a run that is not in the record, by name, and writes nothing', async () => {
    const { post, configDir } = await start()

    const response = await post({
      sessionId: 'pre-session-alias',
      name: 'clean-frame',
      fromRunId: 'run-that-never-ran'
    })

    // 「记录里没有」是一次具名拒答，不是写出一份空技能：状态与理由都要能读出来。
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      result: { state: string; reason: string; detail: string }
    }
    expect(payload.result).toMatchObject({ state: 'refused', reason: 'not-found' })
    expect(payload.result.detail).toContain('run-that-never-ran')
    await expect(readdir(join(configDir, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
