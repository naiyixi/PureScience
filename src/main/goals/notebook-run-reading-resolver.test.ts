// F2 的生产侧适配器。这里不手搓 `run.json` —— 记录由**产品自己的仓储**（`NotebookRunRepository`）写出，
// 否则「解析器读得懂真实记录」这件事没被验到。指纹只在构造「调用方的主张」时用到收据的哈希函数；
// 断言查的是**性质**（稳定、对内容敏感、跨会话拒绝、未知即拒），不是把一个字面值背下来。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NotebookRunRepository } from '../notebook/repository'
import { notebookRunSourceHash } from '../notebook/run-risk-receipt'
import { createNotebookRunReadingResolver } from './notebook-run-reading-resolver'

const roots: string[] = []

const makeStorageRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'purescience-runs-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const writeRun = async (
  storageRoot: string,
  projectName: string,
  sessionId: string,
  runId: string,
  script: string
): Promise<void> => {
  const repository = new NotebookRunRepository(storageRoot)
  await repository.loadOrCreate({
    projectName,
    sessionId,
    workspaceCwd: storageRoot,
    pythonPath: 'python3'
  })
  await repository.appendRun({
    projectName,
    sessionId,
    run: {
      runId,
      cellId: `cell-${runId}`,
      source: 'agent',
      kernelKind: 'python',
      script,
      status: 'completed',
      startedAt: 100,
      endedAt: 200,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }
  })
}

describe('notebook run reading resolver (F2 production adapter)', () => {
  const session = 'session-owner'
  const script = 'import numpy as np\nprint(np.arange(3))\n'

  it('resolves a run the app itself recorded, and answers the same fingerprint every time', async () => {
    const storageRoot = await makeStorageRoot()
    await writeRun(storageRoot, 'default-project', session, 'run-1', script)
    const resolver = createNotebookRunReadingResolver({ storageRoot })

    const claimed = notebookRunSourceHash(script)
    const first = await resolver.resolve(
      { kind: 'run', id: 'run-1', fingerprint: claimed },
      { sessionId: session }
    )
    const second = await resolver.resolve(
      { kind: 'run', id: 'run-1', fingerprint: claimed },
      { sessionId: session }
    )

    expect(first).toEqual({ ok: true, fingerprint: claimed })
    // 稳定：同一个记录两次解析给出同一个指纹（否则「谁都能复算」是空话）。
    expect(second).toEqual(first)
  })

  it('refuses a claim whose fingerprint is not the record\u2019s', async () => {
    const storageRoot = await makeStorageRoot()
    await writeRun(storageRoot, 'default-project', session, 'run-1', script)
    const resolver = createNotebookRunReadingResolver({ storageRoot })

    // 调用方拿着**另一份**脚本的指纹来主张这条运行（等价于记录被改过之后仍用旧指纹）。
    const stale = notebookRunSourceHash('print("something else")\n')
    const resolved = await resolver.resolve(
      { kind: 'run', id: 'run-1', fingerprint: stale },
      { sessionId: session }
    )
    expect(resolved).toEqual({ ok: false, reason: 'fingerprint-mismatch' })
  })

  it('refuses a reading that belongs to another session', async () => {
    const storageRoot = await makeStorageRoot()
    await writeRun(storageRoot, 'default-project', 'session-someone-else', 'run-9', script)
    const resolver = createNotebookRunReadingResolver({ storageRoot })

    const resolved = await resolver.resolve(
      { kind: 'run', id: 'run-9', fingerprint: notebookRunSourceHash(script) },
      { sessionId: session }
    )
    expect(resolved).toEqual({ ok: false, reason: 'foreign-session' })
  })

  it('answers not-found for an unknown id, an unwired kind, and an empty store', async () => {
    const storageRoot = await makeStorageRoot()
    await writeRun(storageRoot, 'default-project', session, 'run-1', script)
    const resolver = createNotebookRunReadingResolver({ storageRoot })
    const fingerprint = notebookRunSourceHash(script)

    await expect(
      resolver.resolve({ kind: 'run', id: 'no-such-run', fingerprint }, { sessionId: session })
    ).resolves.toEqual({ ok: false, reason: 'not-found' })
    // 未接的那两类读数**具名**不给答案，而不是含糊地「找到了」。
    await expect(
      resolver.resolve(
        { kind: 'artifact-version', id: 'artifact-1', fingerprint },
        { sessionId: session }
      )
    ).resolves.toEqual({ ok: false, reason: 'not-found' })

    const empty = await makeStorageRoot()
    await expect(
      createNotebookRunReadingResolver({ storageRoot: empty }).resolve(
        { kind: 'run', id: 'run-1', fingerprint },
        { sessionId: session }
      )
    ).resolves.toEqual({ ok: false, reason: 'not-found' })
  })
})
