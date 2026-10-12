// Provider translator tests: the request it actually sends, the ways a provider can fail (each named), and the
// one leak that matters — a credential echoed back by a provider must never reach a logged reason.

import { describe, expect, it, vi } from 'vitest'

import type { TranslationUnit } from '../../shared/translation-units'
import { createProviderTranslator, parseChatCompletionText } from './provider-translator'

const unit: TranslationUnit = {
  id: 'p1#2',
  page: 1,
  paragraph: 2,
  text: 'Nirmatrelvir inhibits the SARS-CoV-2 main protease.'
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const target = { url: 'https://api.example.com/v1/chat/completions', key: 'sk-secret', model: 'm1' }

describe('parseChatCompletionText', () => {
  it('reads the first choice message, and reports absence rather than an empty string', () => {
    expect(parseChatCompletionText({ choices: [{ message: { content: ' 你好 ' } }] })).toEqual(
      ' 你好 '
    )
    expect(parseChatCompletionText({ choices: [{ message: { content: '   ' } }] })).toEqual(null)
    expect(parseChatCompletionText({ choices: [] })).toEqual(null)
    expect(parseChatCompletionText({})).toEqual(null)
    expect(parseChatCompletionText(null)).toEqual(null)
  })
})

describe('provider translator', () => {
  it('sends one request per unit, with the paragraph as the user message and no source text in the system prompt', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: '奈玛特韦抑制…' } }] })
    )
    const translate = createProviderTranslator(target, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const outcome = await translate(unit)

    expect(outcome).toEqual({ ok: true, text: '奈玛特韦抑制…' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toEqual(target.url)
    const body = JSON.parse(String(init.body)) as {
      model: string
      stream: boolean
      temperature: number
      messages: { role: string; content: string }[]
    }
    expect(body.model).toEqual('m1')
    expect(body.stream).toEqual(false)
    expect(body.temperature).toEqual(0)
    expect(body.messages[0]?.role).toEqual('system')
    expect(body.messages[0]?.content).toContain('Simplified Chinese')
    expect(body.messages[0]?.content).not.toContain(unit.text)
    expect(body.messages[1]).toEqual({ role: 'user', content: unit.text })
  })

  it('sends the key as both bearer and x-api-key, like the model-list request does', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '译' } }] }))
    await createProviderTranslator(target, { fetchImpl: fetchImpl as unknown as typeof fetch })(
      unit
    )
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.headers).toMatchObject({
      authorization: 'Bearer sk-secret',
      'x-api-key': 'sk-secret'
    })
  })

  it('names a rejected credential rather than reporting a generic failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401))
    const outcome = await createProviderTranslator(target, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })(unit)
    expect(outcome).toEqual({ ok: false, reason: 'unauthorized (401)' })
  })

  it('quotes a bounded, redacted body for other HTTP failures', async () => {
    const long = `key sk-secret rejected: ${'x'.repeat(400)}`
    const fetchImpl = vi.fn(async () => new Response(long, { status: 500 }))
    const outcome = await createProviderTranslator(target, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })(unit)
    expect(outcome.ok).toEqual(false)
    if (outcome.ok) return
    expect(outcome.reason.startsWith('http-error (500): ')).toEqual(true)
    expect(outcome.reason).not.toContain('sk-secret')
    expect(outcome.reason).toContain('[redacted]')
    expect(outcome.reason.length).toBeLessThan(300)
  })

  it('does not leak the key through a network error message either', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED sk-secret')
    })
    const outcome = await createProviderTranslator(target, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })(unit)
    expect(outcome.ok).toEqual(false)
    if (outcome.ok) return
    expect(outcome.reason).not.toContain('sk-secret')
  })

  it('names a non-JSON body and an empty completion separately', async () => {
    const notJson = vi.fn(async () => new Response('<html>nope</html>', { status: 200 }))
    expect(
      await createProviderTranslator(target, { fetchImpl: notJson as unknown as typeof fetch })(
        unit
      )
    ).toEqual({ ok: false, reason: 'malformed-response' })

    const empty = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '' } }] }))
    expect(
      await createProviderTranslator(target, { fetchImpl: empty as unknown as typeof fetch })(unit)
    ).toEqual({ ok: false, reason: 'empty-response' })
  })

  it('bounds the request with a timeout instead of hanging a whole document', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
    )
    const outcome = await createProviderTranslator(target, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5
    })(unit)
    expect(outcome).toEqual({ ok: false, reason: 'timeout after 5ms' })
  })

  it('rejects a target it cannot use before spending a request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    const noEndpoint = createProviderTranslator(
      { ...target, url: 'not a url' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )
    expect(await noEndpoint(unit)).toEqual({ ok: false, reason: 'invalid-endpoint' })

    const noModel = createProviderTranslator(
      { ...target, model: '  ' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )
    expect(await noModel(unit)).toEqual({ ok: false, reason: 'no-model' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('works against a provider that needs no key (a local gateway)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '译' } }] }))
    const outcome = await createProviderTranslator(
      { url: target.url, model: 'local' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )(unit)
    expect(outcome).toEqual({ ok: true, text: '译' })
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.headers).not.toHaveProperty('authorization')
  })
})
