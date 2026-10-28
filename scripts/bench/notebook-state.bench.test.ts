// Times `loadOrCreate` on a large run.json — the `loadMs` phase that dominated every slow
// `notebook:state` sample in the 2.19.0 logs (207–902 ms, `cold: 0`).
// Run: PURESCIENCE_BENCH_NOTEBOOK_STATE=1 npx vitest run scripts/bench/notebook-state.bench.test.ts
import { appendFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { NotebookRunRepository, getNotebookRunJsonPath } from '../../src/main/notebook/repository'

const enabled = process.env.PURESCIENCE_BENCH_NOTEBOOK_STATE === '1'

describe.skipIf(!enabled)('notebook document load cost', () => {
  it('reports cold vs warm load for a large document', async () => {
    const root =
      process.env.PURESCIENCE_BENCH_STORAGE_ROOT ??
      join(homedir(), '.hermes', 'cache', 'scratch', `nb-bench-${Date.now()}`)
    const runs = Number(process.env.PURESCIENCE_BENCH_RUNS ?? '300')
    const projectName = 'bench-project'
    const sessionId = 'bench-session'

    const filePath = getNotebookRunJsonPath(root, projectName, sessionId)
    await mkdir(join(filePath, '..'), { recursive: true })

    const document = {
      version: 2,
      projectName,
      sessionId,
      workspaceCwd: '/workspace',
      notebookSessionRoot: '',
      dataRoot: '',
      kernel: {
        language: 'python',
        pythonPath: '/usr/bin/python3',
        kernelName: 'python3',
        runtimeRoot: '',
        lastKnownStatus: 'idle'
      },
      runs: Array.from({ length: runs }, (_, index) => ({
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'analysis',
        kernelKind: 'python',
        script: `print(${index})`,
        status: 'succeeded',
        workingFiles: [],
        artifacts: [],
        inputFiles: [],
        startedAt: new Date(Date.now() - index * 1000).toISOString(),
        outputs: [{ kind: 'stream', text: `line ${index}\n`.repeat(20) }]
      }))
    }
    await writeFile(filePath, JSON.stringify(document, null, 2), 'utf8')

    const repository = new NotebookRunRepository(root)
    const request = {
      projectName,
      sessionId,
      workspaceCwd: '/workspace',
      pythonPath: '/usr/bin/python3',
      kernelName: 'python3'
    }

    const durations: number[] = []
    for (let index = 0; index < 6; index += 1) {
      const started = process.hrtime.bigint()
      await repository.loadOrCreate(request)
      durations.push(Number(process.hrtime.bigint() - started) / 1e6)
    }
    const warm = durations.slice(1).sort((a, b) => a - b)
    const bytes = Buffer.byteLength(JSON.stringify(document))

    // Written to a file rather than console: vitest's default reporter swallows test stdout in this repo.
    appendFileSync(
      process.env.PURESCIENCE_BENCH_OUT ?? '/tmp/notebook-load.txt',
      `runs=${runs} bytes=${bytes} cold=${durations[0].toFixed(1)}ms ` +
        `warm_p50=${warm[Math.floor(warm.length / 2)].toFixed(1)}ms ` +
        `all=${durations.map((d) => d.toFixed(1)).join(',')}\n`
    )
    expect(durations[0]).toBeGreaterThan(0)
    await rm(root, { recursive: true, force: true })
  }, 180_000)

  // Real documents on this machine reach 60 MB, which is where the 207–902 ms `loadMs` samples come
  // from. Point PURESCIENCE_BENCH_REAL_RUN_JSON at one to measure the actual thing instead of a
  // synthetic 133 KB file that loads in 1 ms and proves nothing.
  it.skipIf(!process.env.PURESCIENCE_BENCH_REAL_RUN_JSON)(
    'reports cold vs warm load for a real run.json',
    async () => {
      const filePath = process.env.PURESCIENCE_BENCH_REAL_RUN_JSON as string
      const match = /notebooks\/([^/]+)\/([^/]+)\/run\.json$/.exec(filePath)
      expect(match).toBeTruthy()
      const [, projectName, sessionId] = match as RegExpExecArray
      const storageRoot = filePath.slice(0, filePath.indexOf('/notebooks/'))

      const repository = new NotebookRunRepository(storageRoot)
      const request = {
        projectName,
        sessionId,
        workspaceCwd: '/workspace',
        pythonPath: '/usr/bin/python3',
        kernelName: 'python3'
      }

      const durations: number[] = []
      let runs = 0
      for (let index = 0; index < 5; index += 1) {
        const started = process.hrtime.bigint()
        const document = await repository.loadOrCreate(request)
        durations.push(Number(process.hrtime.bigint() - started) / 1e6)
        runs = document.runs.length
      }
      const warm = durations.slice(1).sort((a, b) => a - b)
      appendFileSync(
        process.env.PURESCIENCE_BENCH_OUT ?? '/tmp/notebook-load.txt',
        `REAL runs=${runs} cold=${durations[0].toFixed(1)}ms ` +
          `warm_p50=${warm[Math.floor(warm.length / 2)].toFixed(1)}ms ` +
          `all=${durations.map((d) => d.toFixed(1)).join(',')}\n`
      )
    },
    300_000
  )
})
