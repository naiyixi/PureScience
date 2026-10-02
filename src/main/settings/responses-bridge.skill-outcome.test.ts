import { describe, expect, it, vi } from 'vitest'

import { ResponsesBridge } from './responses-bridge'

// A failed call and an answered-but-empty one both come back as `[]`. The function-model trail must not
// record the first as "the configured model answered" — that is a claim about a call that never succeeded —
// so the bridge says what it actually did and the caller reads it back.

const catalog = [
  { name: 'pubmed-search', description: 'Search PubMed', path: '/s/SKILL.md' }
] as never

describe('ResponsesBridge.skillSelectionOutcome', () => {
  it('reports a failed call as failed, not as an empty answer', async () => {
    const failing = vi.fn(async () => {
      throw new Error('connection refused')
    })
    const bridge = new ResponsesBridge(
      { baseUrl: 'http://127.0.0.1:9/v1', key: 'k' },
      failing as never
    )

    await expect(bridge.selectSkills('find papers', catalog)).resolves.toEqual([])
    expect(failing).toHaveBeenCalledOnce()
    expect(bridge.skillSelectionOutcome()).toBe('failed')
  })

  it('reports "skipped" when there was nothing to ask about (no request is made)', async () => {
    const never = vi.fn()
    const bridge = new ResponsesBridge(
      { baseUrl: 'http://127.0.0.1:9/v1', key: 'k' },
      never as never
    )

    await expect(bridge.selectSkills('find papers', [] as never)).resolves.toEqual([])
    expect(never).not.toHaveBeenCalled()
    expect(bridge.skillSelectionOutcome()).toBe('skipped')
  })

  it('reports an answer as answered even when it selected nothing', async () => {
    const answering = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [{ function: { name: 'select_skills', arguments: '{"skill_names":[]}' } }]
            }
          }
        ]
      })
    }))
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://vendor.example/v1', key: 'k' },
      answering as never
    )

    await expect(bridge.selectSkills('find papers', catalog)).resolves.toEqual([])
    expect(bridge.skillSelectionOutcome()).toBe('answered')
  })
})
