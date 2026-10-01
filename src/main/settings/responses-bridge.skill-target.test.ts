import { describe, expect, it, vi } from 'vitest'

import { ResponsesBridge } from './responses-bridge'

// A function-level slot is only real if the narrow call actually goes to the configured model. This is the
// case that makes the difference between "the settings row says so" and "the request went there".

const catalog = [
  { name: 'pubmed-search', description: 'Search PubMed' },
  { name: 'figures', description: 'Render figures' }
] as never

const completionFor = (names: string[]): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'select_skills',
                  arguments: JSON.stringify({ skill_names: names })
                }
              }
            ]
          }
        }
      ]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

describe('skill selection honours a per-call target', () => {
  it('calls the session target when no override is given', async () => {
    const fetchImpl = vi.fn(async () => completionFor(['figures']))
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://session.example/v1', key: 'session-key', model: 'session-model' },
      fetchImpl as never
    )

    await expect(bridge.selectSkills('draw a figure', catalog)).resolves.toEqual([
      expect.objectContaining({ name: 'figures' })
    ])

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('session.example')
    expect(JSON.parse(String(init.body)).model).toBe('session-model')
  })

  it('calls the configured model instead, with its own endpoint and key', async () => {
    const fetchImpl = vi.fn(async () => completionFor(['pubmed-search']))
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://session.example/v1', key: 'session-key', model: 'session-model' },
      fetchImpl as never
    )

    await expect(
      bridge.selectSkills('search pubmed', catalog, undefined, {
        baseUrl: 'https://configured.example/v1',
        key: 'configured-key',
        model: 'small-model'
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'pubmed-search' })])

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    // The whole point: the narrow call leaves for the configured service, not the session's.
    expect(String(url)).toContain('configured.example')
    expect(String(url)).toContain('/chat/completions')
    expect(JSON.parse(String(init.body)).model).toBe('small-model')
    expect((init.headers as Record<string, string>).authorization).toContain('configured-key')
  })

  it('leaves the session target untouched afterwards', async () => {
    const fetchImpl = vi.fn(async () => completionFor(['figures']))
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://session.example/v1', key: 'session-key', model: 'session-model' },
      fetchImpl as never
    )

    await bridge.selectSkills('search pubmed', catalog, undefined, {
      baseUrl: 'https://configured.example/v1',
      key: 'configured-key',
      model: 'small-model'
    })
    await bridge.selectSkills('draw a figure', catalog)

    // A per-call override must not become sticky: the next ordinary turn still uses the session's model.
    const [, secondInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(String(secondInit.body)).model).toBe('session-model')
  })
})
