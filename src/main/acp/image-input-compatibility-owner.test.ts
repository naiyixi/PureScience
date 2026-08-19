import { describe, expect, it, vi } from 'vitest'

import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import { ImageInputCompatibilityError, ImageInputCompatibilityOwner } from './image-input-compatibility-owner'

const sha256 = async (value: string): Promise<string> => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(value).digest('hex')
}

const imageBlock = (data: string, mimeType = 'image/png'): ContentBlock => ({
  type: 'image',
  data,
  mimeType
})

const target: ExplicitAgentBackendTarget = Object.freeze({
  frameworkId: 'claude-code',
  providerId: 'vision-provider',
  model: Object.freeze({ kind: 'required', id: 'vision-model' }),
  reasoningEffort: 'default'
})

const validEvidenceJson = JSON.stringify({
  summary: 'A chart of sales.',
  findings: ['Sales grew in Q3'],
  transcription: '',
  regions: [{ kind: 'chart', description: 'bar chart' }],
  entities: [{ name: 'Q3', type: 'quarter' }],
  relations: [{ source: 'Q3', relation: 'after', target: 'Q2' }],
  uncertainty: []
})

const createOwner = (overrides: Record<string, unknown> = {}) => {
  const runner = {
    run: vi.fn(async () => ({ text: validEvidenceJson }))
  }
  const evidenceRepository = {
    find: vi.fn(async () => undefined as string | undefined),
    save: vi.fn(async () => undefined) as unknown as { save: (input: never) => Promise<void>; mock: { calls: Array<[Record<string, unknown>]> } }
  }
  const captureTarget = vi.fn(async () => target)
  const owner = new ImageInputCompatibilityOwner({
    captureTarget,
    runner,
    evidenceRepository,
    ...overrides
  } as never)
  return { owner, runner, evidenceRepository, captureTarget }
}

describe('ImageInputCompatibilityOwner.prepare', () => {
  it('passes content through unchanged when the backend supports image input', async () => {
    const { owner, runner } = createOwner()
    const content = [imageBlock('AAAA')]
    const result = await owner.prepare({ content, supportsImageInput: true })
    expect(result).toBe(content)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('passes string content through unchanged', async () => {
    const { owner, runner } = createOwner()
    const result = await owner.prepare({ content: 'plain text', supportsImageInput: false })
    expect(result).toBe('plain text')
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('passes content through unchanged when it has no image blocks', async () => {
    const { owner, runner } = createOwner()
    const content: ContentBlock[] = [{ type: 'text', text: 'hello' }]
    const result = await owner.prepare({ content, supportsImageInput: false })
    expect(result).toBe(content)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('replaces image blocks with evidence text for a text-only backend', async () => {
    const { owner, runner } = createOwner()
    const content: ContentBlock[] = [
      { type: 'text', text: 'Look at this:' },
      imageBlock('QUJD')
    ]
    const result = (await owner.prepare({
      content,
      supportsImageInput: false,
      projectId: 'p1',
      sessionId: 's1'
    })) as ContentBlock[]
    expect(result[0]).toBe(content[0])
    expect(result[1]).toMatchObject({ type: 'text' })
    expect((result[1] as { text: string }).text).toContain('attached-image-evidence')
    expect((result[1] as { text: string }).text).toContain('Summary: A chart of sales.')
    expect(runner.run).toHaveBeenCalledTimes(1)
  })

  it('saves evidence to the repository after a fresh analysis', async () => {
    const { owner, evidenceRepository } = createOwner()
    const content: ContentBlock[] = [imageBlock('QUJD')]
    await owner.prepare({
      content,
      supportsImageInput: false,
      projectId: 'p1',
      sessionId: 's1',
      imageSources: [{ kind: 'message-image', messageId: 'msg-1', imageId: 'img-1' }]
    })
    expect(evidenceRepository.save).toHaveBeenCalledTimes(1)
    const saved = evidenceRepository.save.mock.calls[0][0] as Record<string, unknown> & {
      source: { kind: string }
      evidenceJson: string
    }
    expect(saved.projectId).toBe('p1')
    expect(saved.sessionId).toBe('s1')
    expect(saved.source.kind).toBe('message-image')
    expect(JSON.parse(saved.evidenceJson).summary).toBe('A chart of sales.')
  })

  it('reuses persisted evidence and skips the runner', async () => {
    const { owner, runner, evidenceRepository } = createOwner()
    void runner
    evidenceRepository.find.mockResolvedValue(validEvidenceJson)
    const content: ContentBlock[] = [imageBlock('QUJD')]
    await owner.prepare({
      content,
      supportsImageInput: false,
      projectId: 'p1',
      sessionId: 's1',
      imageSources: [{ kind: 'message-image', messageId: 'msg-1', imageId: 'img-1' }]
    })
    expect(runner.run).not.toHaveBeenCalled()
    expect((content[0] as { type: string }).type).toBe('image')
  })

  it('throws not-configured when no Vision model is set and there are current images', async () => {
    const { owner } = createOwner({ captureTarget: vi.fn(async () => undefined) })
    const content: ContentBlock[] = [imageBlock('QUJD')]
    await expect(
      owner.prepare({ content, supportsImageInput: false, projectId: 'p1', sessionId: 's1' })
    ).rejects.toThrow(ImageInputCompatibilityError)
  })

  it('degrades historical images to omission markers when the relay is unavailable', async () => {
    const { owner, runner } = createOwner({ captureTarget: vi.fn(async () => undefined) })
    const content: ContentBlock[] = [imageBlock('QUJD')]
    const result = (await owner.prepare({
      content,
      supportsImageInput: false,
      projectId: 'p1',
      sessionId: 's1',
      historyImageCount: 1
    })) as ContentBlock[]
    expect((result[0] as { text: string }).text).toContain('status="omitted"')
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('rejects invalid evidence returned by the Vision model', async () => {
    const { owner } = createOwner({
      runner: { run: vi.fn(async () => ({ text: 'not json at all' })) }
    })
    const content: ContentBlock[] = [imageBlock('QUJD')]
    await expect(
      owner.prepare({ content, supportsImageInput: false, projectId: 'p1', sessionId: 's1' })
    ).rejects.toThrow(/invalid image evidence/)
  })

  it('rejects oversized resource_link images', async () => {
    const { owner } = createOwner()
    const content: ContentBlock[] = [
      { type: 'resource_link', uri: 'file:///big.png', name: 'big.png', mimeType: 'image/png', size: 10_000_000 }
    ]
    await expect(
      owner.prepare({ content, supportsImageInput: false, projectId: 'p1', sessionId: 's1' })
    ).rejects.toThrow(/too large/)
  })

  it('isAvailable reports false when no Vision model is configured', async () => {
    const { owner } = createOwner({ captureTarget: vi.fn(async () => undefined) })
    await expect(owner.isAvailable()).resolves.toBe(false)
  })

  it('isAvailable reports true when a Vision model resolves', async () => {
    const { owner } = createOwner()
    await expect(owner.isAvailable()).resolves.toBe(true)
  })

  it('uses the same extractor fingerprint for identical targets (stable cache identity)', async () => {
    const { owner, runner } = createOwner()
    const content: ContentBlock[] = [imageBlock('QUJD')]
    await owner.prepare({ content, supportsImageInput: false, projectId: 'p1', sessionId: 's1' })
    await owner.prepare({ content, supportsImageInput: false, projectId: 'p1', sessionId: 's1' })
    // Second prepare hits the in-memory cache; the runner runs once.
    expect(runner.run).toHaveBeenCalledTimes(1)
  })
})

// Keep the sha256 helper referenced so tree-shaking never flags it in coverage runs.
void sha256
