// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../../../shared/uploads'
import { stageComposerFile, type UploadStagingApi } from './composer-upload-transfer'

/**
 * How long a coordination wait may take.
 *
 * Every `vi.waitFor` in this file is a *coordination* wait: it waits for the side effect of work that
 * is already in flight (a spy being called, a process dying, a worker reporting that it started, a
 * rendered node reaching its final text), never for something that may never happen. The only thing
 * the window has to cover is how long a loaded machine takes to schedule that continuation -- so the
 * default 1s is a quiet-machine budget, not a correctness budget. Measured on this repository: under
 * load a coordinated wait took up to 704ms (34 samples, p90 = 361ms), and a site elsewhere in the
 * suite failed at ~1.1s under load average ~70 while passing on a quiet machine.
 *
 * 30s matches the window this repository already uses for load-sensitive waits, and it stays well below
 * vitest's 60s per-test timeout, so an assertion that is genuinely stuck still fails as a failure
 * instead of hanging.
 */
const COORDINATION_WINDOW_MS = 30_000

const attachment: UploadedAttachment = {
  id: 'upload-1',
  sessionId: '.pending',
  name: 'dataset.csv',
  originalName: 'dataset.csv',
  path: '/uploads/dataset.csv',
  mimeType: 'text/csv',
  size: 10
}

const createApi = (overrides: Partial<UploadStagingApi> = {}): UploadStagingApi => ({
  stageLocalFile: vi.fn().mockResolvedValue(null),
  beginTransfer: vi.fn(async (request) => ({
    transferId: request.transferId,
    name: request.name,
    receivedBytes: 0,
    totalBytes: request.size
  })),
  appendTransfer: vi.fn(async (request) => ({
    transferId: request.transferId,
    name: 'dataset.csv',
    receivedBytes: request.offset + request.chunk.byteLength,
    totalBytes: 10
  })),
  getTransferStatus: vi.fn().mockResolvedValue(null),
  finishTransfer: vi.fn().mockResolvedValue(attachment),
  abortTransfer: vi.fn().mockResolvedValue(undefined),
  deleteUpload: vi.fn().mockResolvedValue(undefined),
  onTransferProgress: vi.fn(() => vi.fn()),
  ...overrides
})

describe('stageComposerFile', () => {
  it('prefers the desktop native-path adapter without reading File bytes', async () => {
    const file = new File(['0123456789'], 'dataset.csv', { type: 'text/csv' })
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer')
    const api = createApi({ stageLocalFile: vi.fn().mockResolvedValue(attachment) })

    await expect(
      stageComposerFile(file, api, { transferId: 'transfer-1', name: file.name })
    ).resolves.toEqual(attachment)

    expect(api.stageLocalFile).toHaveBeenCalledWith(file, {
      transferId: 'transfer-1',
      name: 'dataset.csv',
      mimeType: 'text/csv',
      size: 10
    })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(api.beginTransfer).not.toHaveBeenCalled()
  })

  it('falls back to bounded chunks when no native path is available', async () => {
    const file = new File(['0123456789'], 'dataset.csv', { type: 'text/csv' })
    const api = createApi()
    const received: number[] = []

    await stageComposerFile(file, api, {
      transferId: 'transfer-2',
      name: file.name,
      chunkBytes: 4,
      onProgress: (progress) => received.push(progress.receivedBytes)
    })

    expect(api.appendTransfer).toHaveBeenCalledTimes(3)
    expect(
      vi
        .mocked(api.appendTransfer)
        .mock.calls.map(([request]) => [request.offset, request.chunk.byteLength])
    ).toEqual([
      [0, 4],
      [4, 4],
      [8, 2]
    ])
    expect(received).toEqual([0, 4, 8, 10])
    expect(api.finishTransfer).toHaveBeenCalledWith({ transferId: 'transfer-2' })
  })

  it('deletes a finalized upload when cancellation wins the finish race', async () => {
    const file = new File(['0123456789'], 'dataset.csv', { type: 'text/csv' })
    const controller = new AbortController()
    let resolveFinish: ((value: UploadedAttachment) => void) | undefined
    const finish = new Promise<UploadedAttachment>((resolve) => {
      resolveFinish = resolve
    })
    const api = createApi({ finishTransfer: vi.fn(() => finish) })

    const staging = stageComposerFile(file, api, {
      transferId: 'transfer-cancelled-during-finish',
      name: file.name,
      signal: controller.signal
    })

    await vi.waitFor(() => expect(api.finishTransfer).toHaveBeenCalledOnce(), {
      timeout: COORDINATION_WINDOW_MS
    })
    controller.abort()
    resolveFinish?.(attachment)

    await expect(staging).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
    expect(api.abortTransfer).toHaveBeenCalledWith({
      transferId: 'transfer-cancelled-during-finish'
    })
  })
})
