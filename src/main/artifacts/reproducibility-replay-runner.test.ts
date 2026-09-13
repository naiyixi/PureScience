import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  replayEnvironment,
  runSealedRecipeReplay,
  type ReplayInputSource,
  type ReplayProcessResult,
  type ReplaySpawnRequest
} from './reproducibility-replay-runner'

let scratch: string | undefined

const createScratch = async (): Promise<string> => {
  scratch = await mkdtemp(join(tmpdir(), 'purescience-replay-test-'))
  return scratch
}

const writeInput = async (filename: string, content: string): Promise<ReplayInputSource> => {
  const dir = scratch ?? (await createScratch())
  const path = join(dir, filename)
  await writeFile(path, content, 'utf8')

  return {
    filename,
    path,
    sizeBytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex')
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// A stand-in for the interpreter: it runs inside the replay's working directory, so it can both prove
// the staged inputs are there and produce the file the recipe expects.
const interpreterWriting = (
  filename: string,
  content: string
): Mock<(request: ReplaySpawnRequest) => Promise<ReplayProcessResult>> =>
  vi.fn(async (request: ReplaySpawnRequest) => {
    await writeFile(join(request.cwd, filename), content, 'utf8')

    return { exitCode: 0, timedOut: false, stdout: 'ok', stderr: '' }
  })

afterEach(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
    scratch = undefined
  }
})

describe('runSealedRecipeReplay', () => {
  it('runs the recorded script in an isolated directory and observes the expected output', async () => {
    const spawnProcess = interpreterWriting('cos.png', 'reproduced bytes')
    const result = await runSealedRecipeReplay({
      kernelKind: 'python',
      scripts: ['import matplotlib.pyplot as plt'],
      interpreterPath: '/managed/bin/python',
      expectedOutputFilenames: ['cos.png'],
      inputs: [],
      spawnProcess
    })

    expect(result.state).toBe('completed')
    expect(result.missingOutputs).toEqual([])
    expect(result.outputs).toEqual([
      {
        filename: 'cos.png',
        sizeBytes: Buffer.byteLength('reproduced bytes'),
        sha256: createHash('sha256').update('reproduced bytes').digest('hex')
      }
    ])
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(spawnProcess.mock.calls[0][0]).toMatchObject({
      command: '/managed/bin/python',
      args: ['replay.py']
    })
    expect(spawnProcess.mock.calls[0][0].env.MPLBACKEND).toBe('Agg')
    // The isolated directory is removed once the run finished.
    expect(await exists(spawnProcess.mock.calls[0][0].cwd)).toBe(false)
  })

  it('stages the recorded inputs before the interpreter starts', async () => {
    const input = await writeInput('groups.csv', 'group,value\na,1\n')
    const spawnProcess = vi.fn(async (request: ReplaySpawnRequest) => {
      // The replay script may only read the recorded input; it must already be in the working dir.
      expect(await readFile(join(request.cwd, 'groups.csv'), 'utf8')).toBe('group,value\na,1\n')
      await writeFile(join(request.cwd, 'cos.png'), 'plot', 'utf8')

      return { exitCode: 0, timedOut: false, stdout: '', stderr: '' }
    })

    const result = await runSealedRecipeReplay({
      kernelKind: 'python',
      scripts: ['df = pd.read_csv("groups.csv")'],
      interpreterPath: '/managed/bin/python',
      expectedOutputFilenames: ['cos.png'],
      inputs: [input],
      spawnProcess
    })

    expect(result.state).toBe('completed')
    expect(spawnProcess).toHaveBeenCalledTimes(1)
  })

  it('refuses to run when a recorded input has lost its content', async () => {
    const input = await writeInput('groups.csv', 'group,value\na,1\n')
    await rm(input.path)
    const spawnProcess = interpreterWriting('cos.png', 'plot')

    const result = await runSealedRecipeReplay({
      kernelKind: 'python',
      scripts: ['df = pd.read_csv("groups.csv")'],
      interpreterPath: '/managed/bin/python',
      expectedOutputFilenames: ['cos.png'],
      inputs: [input],
      spawnProcess
    })

    expect(result.state).toBe('refused')
    expect(result.refusal).toBe('input-missing')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('refuses to run when a recorded input no longer matches its checksum', async () => {
    const input = await writeInput('groups.csv', 'group,value\na,1\n')
    await writeFile(input.path, 'group,value\na,2\n', 'utf8')
    const spawnProcess = interpreterWriting('cos.png', 'plot')

    const result = await runSealedRecipeReplay({
      kernelKind: 'python',
      scripts: ['df = pd.read_csv("groups.csv")'],
      interpreterPath: '/managed/bin/python',
      expectedOutputFilenames: ['cos.png'],
      inputs: [input],
      spawnProcess
    })

    expect(result.state).toBe('refused')
    expect(result.refusal).toBe('input-checksum-mismatch')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('refuses to run when a recorded input changed size', async () => {
    const input = await writeInput('groups.csv', 'group,value\n')
    await writeFile(input.path, 'group,value\na,1\n', 'utf8')
    const spawnProcess = interpreterWriting('cos.png', 'plot')

    const result = await runSealedRecipeReplay({
      kernelKind: 'python',
      scripts: ['df = pd.read_csv("groups.csv")'],
      interpreterPath: '/managed/bin/python',
      expectedOutputFilenames: ['cos.png'],
      inputs: [input],
      spawnProcess
    })

    expect(result.state).toBe('refused')
    expect(result.refusal).toBe('input-size-mismatch')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('refuses a recorded name that is not a plain file name', async () => {
    const spawnProcess = interpreterWriting('cos.png', 'plot')

    const result = await runSealedRecipeReplay({
      kernelKind: 'python',
      scripts: ['open("../escape.txt", "w")'],
      interpreterPath: '/managed/bin/python',
      expectedOutputFilenames: ['../escape.png'],
      inputs: [],
      spawnProcess
    })

    expect(result.state).toBe('refused')
    expect(result.refusal).toBe('unsafe-filename')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('reports a failing replay instead of treating it as a reproduction', async () => {
    const result = await runSealedRecipeReplay({
      kernelKind: 'python',
      scripts: ['raise SystemExit(3)'],
      interpreterPath: '/managed/bin/python',
      expectedOutputFilenames: ['cos.png'],
      inputs: [],
      spawnProcess: async () => ({
        exitCode: 3,
        timedOut: false,
        stdout: 'partial',
        stderr: 'boom'
      })
    })

    expect(result.state).toBe('failed')
    expect(result.exitCode).toBe(3)
    expect(result.outputs).toEqual([])
    expect(result.missingOutputs).toEqual(['cos.png'])
    expect(result.stderrTail).toBe('boom')
  })

  it('reports a replay that ran too long', async () => {
    const result = await runSealedRecipeReplay({
      kernelKind: 'python',
      scripts: ['while True: pass'],
      interpreterPath: '/managed/bin/python',
      expectedOutputFilenames: ['cos.png'],
      inputs: [],
      timeoutMs: 5,
      spawnProcess: async () => ({ exitCode: null, timedOut: true, stdout: '', stderr: '' })
    })

    expect(result.state).toBe('timed-out')
    expect(result.detail).toContain('exceeded')
  })

  it('uses the R script name for an R recipe', async () => {
    const spawnProcess = interpreterWriting('cos.png', 'plot')
    await runSealedRecipeReplay({
      kernelKind: 'r',
      scripts: ['png("cos.png")'],
      interpreterPath: '/managed/bin/R',
      expectedOutputFilenames: ['cos.png'],
      inputs: [],
      spawnProcess
    })

    expect(spawnProcess.mock.calls[0][0].args).toEqual(['replay.R'])
  })

  it('keeps the working directory when asked, and removes it otherwise', async () => {
    const keep = vi.fn(async (request: ReplaySpawnRequest) => {
      await writeFile(join(request.cwd, 'cos.png'), 'plot', 'utf8')

      return { exitCode: 0, timedOut: false, stdout: '', stderr: '' }
    })
    await runSealedRecipeReplay({
      kernelKind: 'python',
      scripts: ['pass'],
      interpreterPath: '/managed/bin/python',
      expectedOutputFilenames: ['cos.png'],
      inputs: [],
      spawnProcess: keep,
      keepWorkDir: true
    })
    const keptDir = keep.mock.calls[0][0].cwd

    expect(await exists(keptDir)).toBe(true)
    await rm(keptDir, { recursive: true, force: true })
  })
})

describe('replayEnvironment', () => {
  it('passes a PATH and a headless plotting backend, and nothing else', () => {
    const env = replayEnvironment({ PATH: '/usr/bin', HOME: '/tmp/home', SECRET_TOKEN: 'x' })

    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/tmp/home')
    expect(env.MPLBACKEND).toBe('Agg')
    expect(env.SECRET_TOKEN).toBeUndefined()
  })
})
