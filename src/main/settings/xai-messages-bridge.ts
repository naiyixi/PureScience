// Anthropic Messages → xAI Responses translation bridge.
//
// Claude Code speaks only the Anthropic Messages protocol, and xAI exposes no native Anthropic
// endpoint — its API is OpenAI Responses / Chat Completions. This local HTTP proxy accepts
// `/v1/messages` requests from Claude Code, translates them into an OpenAI Responses request against
// `https://api.x.ai/v1/responses`, and translates the response back (JSON or streamed SSE) into the
// Anthropic wire format, so a Grok subscription (OAuth) or xAI API key can drive Claude Code.
//
// The bridge is deliberately narrow: xAI's Responses endpoint is stateless and tool-compatible, so
// translation covers messages/tools/max_tokens/stream plus the output items Claude Code needs
// (text blocks and tool_use blocks). Unsupported Anthropic fields are dropped rather than guessed.

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses'
const MAX_REQUEST_BYTES = 64 * 1024 * 1024

export type XaiMessagesBridgeTarget = Readonly<{
  id: string
  model: string
  key?: string
}>

export type XaiMessagesBridgeConnection = Readonly<{
  baseUrl: string
  token: string
}>

type JsonObject = Record<string, any>

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('xAI bridge request exceeds the size limit.'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
    request.once('aborted', () => reject(new Error('xAI bridge request was aborted.')))
  })

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

// --- Request translation: Anthropic Messages → OpenAI Responses -------------------------------

type TranslationInput = {
  // Translated top-level request body.
  body: JsonObject
  // Whether the caller must keep streaming enabled (the Anthropic client requested a stream).
  stream: boolean
}

export const toResponsesRequest = (raw: unknown, model: string): TranslationInput | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const body = raw as JsonObject

  const input: JsonObject[] = []
  const rawMessages = Array.isArray(body.messages) ? (body.messages as JsonObject[]) : []

  for (const message of rawMessages) {
    if (typeof message !== 'object' || message === null) continue
    const role = asString(message.role)
    if (role === 'system') {
      // A stray system message becomes a user message with its text.
      if (typeof message.content === 'string') {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: message.content }] })
      }
      continue
    }
    if (role === 'user') {
      const blocks = Array.isArray(message.content) ? (message.content as JsonObject[]) : []
      const textParts: JsonObject[] = []
      const imageParts: JsonObject[] = []
      const toolResults: JsonObject[] = []
      for (const block of blocks) {
        if (typeof block !== 'object' || block === null) continue
        if (block.type === 'tool_result') {
          const callId = asString(block.tool_use_id)
          if (!callId) continue
          const output =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as JsonObject[])
                    .map((part) => (typeof part === 'object' && part !== null && typeof part.text === 'string' ? part.text : ''))
                    .join('\n')
                : ''
          toolResults.push({ type: 'function_call_output', call_id: callId, output })
        } else if (block.type === 'image') {
          const source = typeof block.source === 'object' && block.source !== null ? (block.source as JsonObject) : undefined
          const data = source?.data !== undefined ? String(source.data) : undefined
          const mediaType = asString(source?.media_type)
          if (data && mediaType) {
            imageParts.push({ type: 'input_image', image_url: `data:${mediaType};base64,${data}` })
          }
        } else if (block.type === 'text') {
          const text = asString(block.text)
          if (text) textParts.push({ type: 'input_text', text })
        } else if (typeof block.type === 'string') {
          const text = asString(block.text)
          if (text) textParts.push({ type: 'input_text', text })
        }
      }
      if (typeof message.content === 'string') {
        textParts.push({ type: 'input_text', text: message.content })
      }
      if (textParts.length > 0 || imageParts.length > 0) {
        input.push({ type: 'message', role: 'user', content: [...textParts, ...imageParts] })
      }
      input.push(...toolResults)
    } else if (role === 'assistant') {
      const blocks = Array.isArray(message.content) ? (message.content as JsonObject[]) : []
      const textParts: JsonObject[] = []
      const toolCalls: JsonObject[] = []
      for (const block of blocks) {
        if (typeof block !== 'object' || block === null) continue
        if (block.type === 'tool_use') {
          const name = asString(block.name)
          const callId = asString(block.id)
          if (!name || !callId) continue
          toolCalls.push({
            type: 'function_call',
            call_id: callId,
            name,
            arguments: JSON.stringify(block.input ?? {})
          })
        } else {
          const text = asString(block.text)
          if (text) textParts.push({ type: 'output_text', text })
        }
      }
      if (typeof message.content === 'string' && message.content.length > 0) {
        textParts.push({ type: 'output_text', text: message.content })
      }
      if (textParts.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: textParts })
      }
      input.push(...toolCalls)
    }
  }

  // Anthropic tools (name/description/input_schema) → Responses function tools.
  const tools = Array.isArray(body.tools)
    ? (body.tools as JsonObject[])
        .filter((tool): tool is JsonObject => typeof tool === 'object' && tool !== null)
        .map((tool) => ({
          type: 'function',
          name: asString(tool.name) ?? '',
          ...(asString(tool.description) ? { description: tool.description } : {}),
          parameters: tool.input_schema ?? { type: 'object', properties: {} }
        }))
        .filter((tool) => tool.name.length > 0)
    : undefined

  // Anthropic system may be a string or a list of text blocks.
  let instructions: string | undefined
  if (typeof body.system === 'string') {
    instructions = body.system
  } else if (Array.isArray(body.system)) {
    instructions = (body.system as JsonObject[])
      .map((block) => (typeof block === 'object' && block !== null ? asString(block.text) : undefined))
      .filter((text): text is string => Boolean(text))
      .join('\n\n')
  }

  const out: JsonObject = {
    model,
    input,
    stream: body.stream === true
  }
  if (instructions) out.instructions = instructions
  if (tools && tools.length > 0) out.tools = tools
  if (typeof body.max_tokens === 'number') out.max_output_tokens = body.max_tokens
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p

  return { body: out, stream: out.stream === true }
}

// --- Response translation: OpenAI Responses → Anthropic Messages -------------------------------

const parseArguments = (value: unknown): JsonObject => {
  if (typeof value === 'object' && value !== null) return value as JsonObject
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return typeof parsed === 'object' && parsed !== null ? (parsed as JsonObject) : {}
    } catch {
      return {}
    }
  }
  return {}
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as JsonObject[])
          .filter((part): part is JsonObject => typeof part === 'object' && part !== null)
          .map((part) => asString(part.text) ?? '')
          .join('')
      : ''

export const toAnthropicResponse = (raw: unknown, model: string): JsonObject => {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as JsonObject
  const output = Array.isArray(body.output) ? (body.output as JsonObject[]) : []

  const content: JsonObject[] = []
  let stopReason: string | null = null

  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue
    if (item.type === 'message') {
      const text = textOf(item.content)
      if (text) content.push({ type: 'text', text })
    } else if (item.type === 'function_call') {
      const name = asString(item.name) ?? ''
      const callId = asString(item.call_id) ?? `call_${content.length}`
      content.push({
        type: 'tool_use',
        id: callId,
        name,
        input: parseArguments(item.arguments)
      })
      stopReason = 'tool_use'
    }
  }
  if (stopReason === null && content.length > 0) stopReason = 'end_turn'

  const usage = typeof body.usage === 'object' && body.usage !== null ? (body.usage as JsonObject) : undefined
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0

  return {
    id: asString(body.id) ?? `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  }
}

// --- Streaming: Responses SSE → Anthropic SSE -------------------------------------------------

// Writes one Anthropic SSE event (event: + data: + blank line) to the client response.
const writeSse = (response: ServerResponse, event: string, data: unknown): void => {
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

// Translates an upstream Responses SSE payload into zero or more Anthropic SSE events. Returns the
// number of events written so the caller can flush; content index tracks the running block index.
const translateSseEvent = (
  response: ServerResponse,
  eventName: string,
  data: JsonObject,
  state: { blockIndex: number; messageId: string; started: boolean; model: string }
): void => {
  switch (eventName) {
    case 'response.created': {
      const id = asString(data.id) ?? state.messageId
      state.messageId = id
      writeSse(response, 'message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model: state.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })
      break
    }
    case 'response.output_text.delta': {
      const text = asString(data.delta) ?? ''
      if (!text) return
      if (!state.started) {
        state.started = true
        state.blockIndex = 0
        writeSse(response, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
      }
      writeSse(response, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text }
      })
      break
    }
    case 'response.output_text.done': {
      if (state.started) {
        writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      }
      break
    }
    case 'response.function_call_arguments.delta': {
      const delta = asString(data.delta) ?? ''
      const callId = asString(data.call_id) ?? 'call_1'
      const name = asString(data.name) ?? 'function'
      if (!state.started) {
        state.started = true
        state.blockIndex = 1
        writeSse(response, 'content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: callId, name, input: {} }
        })
      }
      writeSse(response, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.blockIndex,
        delta: { type: 'input_json_delta', partial_json: delta }
      })
      break
    }
    case 'response.function_call_arguments.done': {
      writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: state.blockIndex })
      break
    }
    case 'response.completed': {
      const final = typeof data.response === 'object' && data.response !== null ? (data.response as JsonObject) : undefined
      const output = Array.isArray(final?.output) ? (final.output as JsonObject[]) : []
      const lastToolCall = output.some((item) => typeof item === 'object' && item !== null && item.type === 'function_call')
      const usage = typeof final?.usage === 'object' && final.usage !== null ? (final.usage as JsonObject) : undefined
      writeSse(response, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: lastToolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
          output_tokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0
        }
      })
      writeSse(response, 'message_stop', { type: 'message_stop' })
      break
    }
    case 'response.failed': {
      const error =
        typeof data.error === 'object' && data.error !== null
          ? (data.error as JsonObject)
          : { message: 'xAI request failed.' }
      writeSse(response, 'error', {
        type: 'error',
        error: { type: 'api_error', message: asString(error.message) ?? 'xAI request failed.' }
      })
      break
    }
    default:
      break
  }
}

// --- Bridge server ------------------------------------------------------------------------------

export class XaiMessagesBridge {
  private readonly targets: ReadonlyMap<string, XaiMessagesBridgeTarget>
  private target: XaiMessagesBridgeTarget
  private server: Server | undefined
  private connection: XaiMessagesBridgeConnection | undefined

  constructor(targets: readonly XaiMessagesBridgeTarget[], initialTargetId: string) {
    this.targets = new Map(targets.map((target) => [target.id, target]))
    const initial = this.targets.get(initialTargetId)
    if (!initial) throw new Error('The initial xAI bridge target is not registered.')
    this.target = initial
  }

  setTarget(targetId: string): boolean {
    const target = this.targets.get(targetId)
    if (!target) return false
    this.target = target
    return true
  }

  async start(): Promise<XaiMessagesBridgeConnection> {
    if (this.connection) return this.connection
    const token = randomBytes(24).toString('hex')
    const server = createServer((request, response) => {
      void this.handle(request, response, token).catch((error: unknown) => {
        if (response.destroyed || response.writableEnded) return
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined)
          return
        }
        json(response, 502, {
          error: { type: 'api_error', message: error instanceof Error ? error.message : 'xAI bridge request failed.' }
        })
      })
    })
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      server.unref()
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('xAI bridge did not bind a port.')
      }
      this.connection = Object.freeze({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token
      })
      return this.connection
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.connection = undefined
    if (!server) return
    const closing = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    server.closeAllConnections()
    await closing
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    token: string
  ): Promise<void> {
    const authorization = request.headers.authorization
    const apiKey = request.headers['x-api-key']
    if (authorization !== `Bearer ${token}` && apiKey !== token) {
      json(response, 401, { error: { type: 'authentication_error', message: 'Unauthorized' } })
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { error: { type: 'invalid_request_error', message: 'Method not allowed' } })
      return
    }
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (requestUrl.pathname !== '/v1/messages') {
      json(response, 404, { error: { type: 'not_found_error', message: 'Not found' } })
      return
    }

    const rawBody = await readBody(request)
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown
    const translated = toResponsesRequest(parsed, this.target.model)
    if (!translated) {
      json(response, 400, { error: { type: 'invalid_request_error', message: 'Expected a JSON object request body.' } })
      return
    }

    const controller = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })

    const headers = new Headers({ 'content-type': 'application/json' })
    if (this.target.key) headers.set('authorization', `Bearer ${this.target.key}`)

    const source = await fetch(XAI_RESPONSES_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(translated.body),
      redirect: 'manual',
      signal: controller.signal
    })

    if (source.status !== 200) {
      const errorBody = await source.text().catch(() => '')
      json(response, 502, {
        error: { type: 'api_error', message: `xAI returned HTTP ${source.status}. ${errorBody.slice(0, 300)}` }
      })
      return
    }

    if (!translated.stream) {
      const upstream = (await source.json().catch(() => undefined)) as unknown
      const anthropic = toAnthropicResponse(upstream, this.target.model)
      json(response, 200, anthropic)
      return
    }

    // Streaming: relay the upstream Responses SSE, translating each event.
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const state = { blockIndex: 0, messageId: `msg_${Date.now().toString(36)}`, started: false, model: this.target.model }
    if (!source.body) {
      response.end()
      return
    }
    const reader = Readable.from(source.body as AsyncIterable<Uint8Array>)
    let buffer = ''
    for await (const chunk of reader) {
      buffer += Buffer.from(chunk).toString('utf8')
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            writeSse(response, 'message_stop', { type: 'message_stop' })
            response.end()
            return
          }
          const data = JSON.parse(payload) as { type?: string }
          if (data?.type) {
            translateSseEvent(response, data.type, data as JsonObject, state)
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
    if (response.writableEnded) return
    writeSse(response, 'message_stop', { type: 'message_stop' })
    response.end()
  }
}
