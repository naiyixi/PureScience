import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SCI_BENCH_V1_CASES } from '../../src/shared/sci-bench-v1-cases'
import { runPilot } from './pilot-runner'

// A fake app: the three endpoints the pilot touches, with the shapes the real server returns. This is
// how the runner gets tested without an Electron instance — and without pretending a live run
// happened, since nothing here is written to docs/bench-runs.
const checkpoint = SCI_BENCH_V1_CASES.find((entry) => entry.id === 'checkpoint-resume-order')!

const evidenceBody = {
  found: true,
  evidence: {
    transcript: '恢复了上次的检查点结果，接着做富集分析。',
    turns: ['恢复了上次的检查点结果，接着做富集分析。'],
    toolCalls: [{ name: 'checkpoint_load' }, { name: 'checkpoint_save' }],
    artifacts: [],
    collected: {
      transcript: true,
      toolCalls: true,
      artifacts: false,
      numbers: false,
      citations: false
    }
  }
}

let server: Server
let baseUrl = ''
let outDir = ''
let runStatus = 'completed'
let lastRunBody: Record<string, unknown> | null = null

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'pilot-out-'))
  server = createServer((req, res) => {
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && req.url === '/api/v1/runs') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        lastRunBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        send(202, { data: { id: 'run-1', sessionId: 'session-1' } })
      })
      return
    }
    if (req.method === 'GET' && req.url === '/api/v1/runs/run-1') {
      send(200, { data: { status: runStatus } })
      return
    }
    if (req.method === 'GET' && req.url === '/api/v1/sessions/session-1/evidence') {
      send(200, { data: evidenceBody })
      return
    }
    send(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(outDir, { recursive: true, force: true })
})

describe('runPilot', () => {
  it('starts a run, reads its evidence, grades it and writes one record', async () => {
    runStatus = 'completed'
    const { record, file } = await runPilot({
      baseUrl,
      token: 'test-token',
      project: 'project-1',
      benchCase: checkpoint,
      arm: 'no-contract',
      outDir,
      model: 'deepseek-v4-flash',
      runtime: 'claude-code',
      seed: 7,
      permissionProfile: 'full',
      pollMs: 10
    })

    // The wire shape is the app's, not ours: `project` (not projectId) and the profile that lets a
    // headless run finish without a permission card.
    expect(lastRunBody).toMatchObject({ project: 'project-1', permissionProfile: 'full' })

    expect(record).toMatchObject({
      caseId: 'checkpoint-resume-order',
      arm: 'no-contract',
      runId: 'run-1',
      sessionId: 'session-1',
      runStatus: 'completed',
      model: 'deepseek-v4-flash',
      runtime: 'claude-code',
      seed: 7
    })
    expect(record.result.passed).toBe(true)
    expect(record.evidenceCollected).toMatchObject({ numbers: false, citations: false })

    const written = JSON.parse(await readFile(file, 'utf8')) as typeof record
    expect(written).toEqual(record)
    expect(file).toContain('checkpoint-resume-order-no-contract.json')
  })

  it('records a failed run as a failed run rather than a pass or a hang', async () => {
    runStatus = 'failed'
    const { record } = await runPilot({
      baseUrl,
      token: 'test-token',
      project: 'project-1',
      benchCase: checkpoint,
      arm: 'full-contract',
      outDir,
      pollMs: 10
    })
    expect(record.runStatus).toBe('failed')
    expect(record.result.passed).toBe(true) // graded on what the session recorded, not on the verdict
  })

  it('refuses a server that answers with an error', async () => {
    await expect(
      runPilot({
        baseUrl: `${baseUrl}/nope`,
        token: 'test-token',
        project: 'project-1',
        benchCase: checkpoint,
        arm: 'full-contract',
        outDir,
        pollMs: 10
      })
    ).rejects.toThrow(/HTTP 404/)
  })
})
