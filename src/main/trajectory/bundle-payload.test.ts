import { describe, expect, it } from 'vitest'

import { buildTrajectoryDocuments } from './bundle-payload'

// The acceptance the v2.19 plan asked for and could not state: a bundle that provably carries no
// credentials. Every case here plants a different SHAPE of secret, because a redactor that only knows
// `apiKey` is exactly the kind that ships a `keyRef` ciphertext.

const planted = {
  version: 2,
  id: 'session-1',
  status: 'completed',
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: '帮我看一下这份数据',
      turnUsage: { inputTokens: 1200, cacheTokens: 0, outputTokens: 340 }
    },
    {
      id: 'm2',
      role: 'agent',
      content: '好',
      turnUsage: { inputTokens: 1500, cacheTokens: 100, outputTokens: 90 }
    }
  ],
  providers: [
    {
      id: 'p1',
      name: 'DeepSeek',
      keyRef: 'enc:v1:SUPERSECRETCIPHERTEXT',
      keyMask: 'sk-f...941a',
      apiKey: 'sk-live-abcdef1234567890'
    }
  ],
  headers: { authorization: 'Bearer sk-live-abcdef1234567890', cookie: 'session=abc123' }
}

const needles = ['/Users/alice', 'alice']

const build = async (
  overrides: Partial<Parameters<typeof buildTrajectoryDocuments>[0]> = {}
): Promise<Awaited<ReturnType<typeof buildTrajectoryDocuments>>> =>
  buildTrajectoryDocuments({
    productVersion: '2.19.0',
    sessionId: 'session-1',
    session: planted,
    toolCalls: [{ turnId: 'm2', tool: 'memory_save_note', durationMs: 12, resultBytes: 64 }],
    artifacts: [{ artifactVersionId: 'v1', sha256: 'a'.repeat(64), runId: 'run-1' }],
    capabilities: { servers: ['purescience_memory'], groups: '5 core,9 deferred' },
    needles,
    now: () => new Date('2026-10-25T00:00:00.000Z'),
    ...overrides
  })

const allBytes = (files: Record<string, string>): string => Object.values(files).join('\n')

describe('buildTrajectoryDocuments', () => {
  it('writes the bundle shape the plan specifies', async () => {
    const bundle = await build()

    expect(Object.keys(bundle.files).sort()).toEqual([
      'artifacts.json',
      'capabilities.json',
      'checksums.sha256',
      'manifest.json',
      'session.json',
      'tool-calls.jsonl'
    ])
    expect(bundle.leak).toBeUndefined()
    const manifest = JSON.parse(bundle.files['manifest.json'] ?? '{}') as {
      counts: Record<string, number>
    }
    expect(manifest.counts.messages).toBe(2)
    expect(manifest.counts.messagesWithProviderUsage).toBe(2)
    expect(manifest.counts.toolCalls).toBe(1)
  })

  it('carries no credential of any planted shape, while keeping the structure', async () => {
    const bundle = await build()
    const bytes = allBytes(bundle.files)

    for (const secret of [
      'SUPERSECRETCIPHERTEXT',
      'sk-f…941a',
      'sk-live-abcdef1234567890',
      'session=abc123',
      'enc:v1:'
    ]) {
      expect(bytes, `bundle still contains ${secret}`).not.toContain(secret)
    }
    // Structure survives: the keys are still there, the values are not.
    const session = JSON.parse(bundle.files['session.json'] ?? '{}') as {
      providers: Array<Record<string, unknown>>
      messages: unknown[]
    }
    expect(session.providers).toHaveLength(1)
    expect(session.providers[0]?.keyRef).toBe('REDACTED')
    expect(session.providers[0]?.apiKey).toBe('REDACTED')
    expect(session.messages).toHaveLength(2)
    expect(bundle.redactions).toBeGreaterThan(0)
  })

  it('refuses to hand over a bundle whose own bytes still contain a secret shape', async () => {
    // Path needle planted where the scrubber cannot reach it (a key the redactor does not treat as a
    // secret): the pre-handover self-check must still name the file. This is the case where "we scrubbed
    // it" would be a claim and "we read it back" is evidence.
    const bundle = await build({
      session: { ...planted, note: 'leak: sk-live-abcdef1234567890' },
      needles: [],
      scrub: false
    })

    expect(bundle.leak).toBeDefined()
  })

  it('keeps counts and hashes but drops message text when content is excluded', async () => {
    const withContent = await build()
    const withoutContent = await build({ includeContent: false })
    const bytes = allBytes(withoutContent.files)

    expect(bytes).not.toContain('帮我看一下这份数据')
    const session = JSON.parse(withoutContent.files['session.json'] ?? '{}') as {
      messages: Array<{ contentOmitted?: boolean; turnUsage?: unknown }>
    }
    expect(session.messages.every((message) => message.contentOmitted === true)).toBe(true)
    expect(session.messages.every((message) => message.turnUsage !== undefined)).toBe(true)
    const manifest = JSON.parse(withoutContent.files['manifest.json'] ?? '{}') as {
      includeContent: boolean
    }
    expect(manifest.includeContent).toBe(false)
    // Tool names and artifact locators are structure, not content: they stay.
    expect(bytes).toContain('memory_save_note')
    expect(bytes).toContain('v1')
    expect(withContent.files['checksums.sha256']).not.toBe(withoutContent.files['checksums.sha256'])
  })

  it('emits a checksum per shipped file, over the bytes that ship', async () => {
    const bundle = await build()
    const lines = (bundle.files['checksums.sha256'] ?? '').trim().split('\n')
    const listed = lines.map((line) => line.split('  ')[1]).sort()

    expect(listed).toEqual(
      Object.keys(bundle.files)
        .filter((path) => path !== 'checksums.sha256')
        .sort()
    )
  })

  it('omits sections it was not given instead of writing empty placeholders', async () => {
    const bundle = await build({
      toolCalls: undefined,
      artifacts: undefined,
      capabilities: undefined
    })

    expect(bundle.files['tool-calls.jsonl']).toBeUndefined()
    expect(bundle.files['artifacts.json']).toBeUndefined()
    expect(bundle.files['capabilities.json']).toBeUndefined()
  })

  it('says why a section is absent instead of leaving the reader to guess', async () => {
    const partial = await build({
      toolCalls: undefined,
      artifacts: undefined,
      capabilities: undefined
    })
    const manifest = JSON.parse(partial.files['manifest.json'] ?? '{}') as {
      sections: Record<string, string>
    }

    // 「这一段没有内容」与「这一段没采到」必须写成两个不同的答案。
    expect(manifest.sections.session).toBe('included')
    expect(manifest.sections.toolCalls).toBe('absent:not-collected')
    expect(manifest.sections.artifacts).toBe('absent:not-collected')
    // capabilities 目前无持久化来源，这是具名状态而不是空文件。
    expect(manifest.sections.capabilities).toBe('absent:not-persisted')
  })

  it('marks the session section as included-without-content when content is excluded', async () => {
    const bundle = await build({ includeContent: false })
    const manifest = JSON.parse(bundle.files['manifest.json'] ?? '{}') as {
      sections: Record<string, string>
    }

    expect(manifest.sections.session).toBe('included-without-content')
  })

  it('marks capabilities as included once they are actually supplied', async () => {
    const bundle = await build({ capabilities: { servers: ['purescience_memory'] } })
    const manifest = JSON.parse(bundle.files['manifest.json'] ?? '{}') as {
      sections: Record<string, string>
    }

    expect(manifest.sections.capabilities).toBe('included')
    expect(bundle.files['capabilities.json']).toBeDefined()
  })
})
