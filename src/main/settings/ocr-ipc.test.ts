import { describe, expect, it, vi } from 'vitest'

import { createOcrCommandOwner } from './ocr-ipc'

const service = (outcome: unknown): { recognise: ReturnType<typeof vi.fn> } => ({
  recognise: vi.fn().mockResolvedValue(outcome)
})

const recognised = {
  status: 'recognised',
  text: 'HEMOGLOBIN 12.4',
  language: 'eng',
  packFile: 'eng.traineddata',
  durationMs: 5
}

describe('createOcrCommandOwner', () => {
  it('resolves the file the window named and hands the absolute path to the engine', async () => {
    const ocr = service(recognised)
    const resolve = vi.fn().mockResolvedValue('/Users/x/.purescience/artifacts/gel.png')
    const owner = createOcrCommandOwner(ocr as never, resolve)

    const outcome = await owner.recognise({
      source: 'artifact',
      path: 'gel.png',
      projectId: 'project-1',
      sessionId: 'session-1',
      uiLanguage: 'en'
    })

    expect(outcome).toEqual(recognised)
    expect(resolve).toHaveBeenCalledWith('artifact', {
      path: 'gel.png',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    // The engine never sees the window's own identity strings, only the resolved path.
    expect(ocr.recognise).toHaveBeenCalledWith('/Users/x/.purescience/artifacts/gel.png', 'en')
  })

  it('reports a refused file as unreadable, and never calls the engine', async () => {
    const ocr = service(recognised)
    const resolve = vi.fn().mockRejectedValue(new Error('Path escapes the artifact root'))
    const owner = createOcrCommandOwner(ocr as never, resolve)

    expect(
      await owner.recognise({ source: 'upload', path: '../etc/passwd', uiLanguage: 'en' })
    ).toEqual({ status: 'unreadable', message: 'Path escapes the artifact root' })
    expect(ocr.recognise).not.toHaveBeenCalled()
  })

  it('omits the optional scope keys instead of sending undefined for them', async () => {
    const ocr = service(recognised)
    const resolve = vi.fn().mockResolvedValue('/tmp/gel.png')
    const owner = createOcrCommandOwner(ocr as never, resolve)

    await owner.recognise({ source: 'local', path: '/tmp/gel.png', uiLanguage: 'zh' })

    expect(resolve).toHaveBeenCalledWith('local', { path: '/tmp/gel.png' })
    expect(ocr.recognise).toHaveBeenCalledWith('/tmp/gel.png', 'zh')
  })
})
