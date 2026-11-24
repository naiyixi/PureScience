import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { hermesFramework } from './hermes'
import { createDefaultHermesDetectDeps, detectHermes } from '../settings/hermes-detect'
import type { ResolvedProvider } from '../settings/provider-env'

// Real-machine certification through the app's own code path: the same `prepareModelConfig` output and the
// same `spawn` shape the runtime uses, with a loopback OpenAI-compatible fixture standing in for the
// provider (no paid inference). Skips — loudly — where `hermes` is not installed, because a silent pass
// there would say "verified" about a run that never happened.

type Fixture = { server: Server; baseUrl: string; requests: string[] }

const startFixture = async (): Promise<Fixture> => {
  const requests: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push(`${req.method} ${req.url}`)
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] })
        )
        return
      }
      const wantsStream = body.includes('"stream":true') || body.includes('"stream": true')
      if (wantsStream) {
        const chunk = {
          id: 'fixture-stream',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'fixture-ok' }, finish_reason: 'stop' }
          ]
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'fixture-completion',
          object: 'chat.completion',
          created: 1,
          model: 'fixture-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'fixture-ok' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, requests }
}

const detected = await detectHermes(createDefaultHermesDetectDeps())
const describeIfInstalled = detected ? describe : describe.skip

if (!detected) {
  // Printed so a skipped run is visible in the log rather than inferred from a green test.
  console.warn(
    '[hermes-certification] skipped: no `hermes` executable was detected on this machine'
  )
}

let fixture: Fixture | undefined
let child: ReturnType<typeof hermesFramework.spawn> | undefined

afterEach(async () => {
  child?.kill()
  child = undefined
  if (fixture) {
    await new Promise<void>((resolve) => fixture!.server.close(() => resolve()))
    fixture = undefined
  }
})

describeIfInstalled('hermes over real ACP (certification)', () => {
  it('answers a prompt turn through the app own model config and spawn shape', async () => {
    fixture = await startFixture()
    const storageRoot = await mkdtemp(join(tmpdir(), 'hermes-cert-'))
    const provider = {
      type: 'custom',
      model: 'fixture-model',
      key: 'fixture-key',
      baseUrl: fixture.baseUrl
    } as ResolvedProvider

    const config = hermesFramework.prepareModelConfig(provider, {
      storageRoot,
      executablePath: detected!.resolvedPath,
      nativeVersion: detected!.version
    })

    for (const file of config.configFiles ?? []) {
      await mkdir(join(file.path, '..'), { recursive: true })
      await writeFile(file.path, file.content, 'utf8')
    }

    child = hermesFramework.spawn({
      executablePath: detected!.resolvedPath,
      env: config.env ?? {},
      args: config.args ?? []
    })

    const pending = new Map<number, (value: Record<string, unknown>) => void>()
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line) continue
        try {
          const message = JSON.parse(line) as { id?: number }
          if (typeof message.id === 'number') pending.get(message.id)?.(message)
        } catch {
          // Hermes logs progress on stderr; a non-JSON stdout line is not a protocol violation.
        }
      }
    })

    let nextId = 1
    const rpc = (
      method: string,
      params: Record<string, unknown>
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 120_000)
        pending.set(id, (message) => {
          clearTimeout(timer)
          pending.delete(id)
          resolve(message)
        })
        child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })

    const init = await rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'purescience-certification', version: '1' }
    })
    const initResult = init.result as { agentInfo?: { name?: string }; protocolVersion?: number }
    expect(initResult.protocolVersion).toBe(1)
    expect(initResult.agentInfo?.name).toBe('hermes-agent')

    const opened = await rpc('session/new', { cwd: storageRoot, mcpServers: [] })
    const sessionId = (opened.result as { sessionId?: string }).sessionId
    expect(sessionId).toBeTruthy()

    const prompted = await rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with a short greeting; do not use tools.' }]
    })
    expect((prompted.result as { stopReason?: string }).stopReason).toBe('end_turn')

    // The turn really reached a model endpoint — a terminal reply with no request would mean the app's
    // config pointed somewhere else entirely.
    expect(fixture.requests.some((entry) => entry.startsWith('POST'))).toBe(true)
  }, 240_000)
})
