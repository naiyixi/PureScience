import { describe, expect, it, vi } from 'vitest'

import { createSupportBundleCommandOwner, type SupportBundleFacts } from './support-bundle-ipc'

const facts: SupportBundleFacts = {
  versions: { app: '1.75.0', electron: '43.7.5', chrome: '140.0.0.0', node: '22.22.3' },
  platform: 'darwin',
  arch: 'arm64',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  packaged: true,
  storageLocation: 'default'
}

const sender = {} as never

describe('support bundle command owner', () => {
  it('writes the bundle where the user chose, with the facts and log directory the app supplied', async () => {
    const create = vi.fn(async (input: { outPath: string }) => ({
      path: input.outPath,
      bytes: 2048,
      redactions: 3
    }))
    const owner = createSupportBundleCommandOwner({
      getLogDir: () => '/logs',
      getFacts: () => facts,
      defaultDir: '/downloads',
      showSaveDialog: async () => ({ canceled: false, filePath: '/chosen/bundle.tar.gz' }),
      create,
      now: () => new Date('2026-09-28T12:34:56.000Z')
    })

    await expect(owner.exportBundle(sender)).resolves.toEqual({
      exported: true,
      path: '/chosen/bundle.tar.gz',
      bytes: 2048,
      redactions: 3
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ ...facts, logDir: '/logs', outPath: '/chosen/bundle.tar.gz' })
    )
  })

  it('reports a cancel as "nothing exported" rather than an error, and writes nothing', async () => {
    const create = vi.fn()
    const owner = createSupportBundleCommandOwner({
      getLogDir: () => '/logs',
      getFacts: () => facts,
      defaultDir: '/downloads',
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
      create
    })

    await expect(owner.exportBundle(sender)).resolves.toEqual({ exported: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('surfaces a refused bundle as an error instead of a path', async () => {
    const warn = vi.fn()
    const owner = createSupportBundleCommandOwner({
      getLogDir: () => '/logs',
      getFacts: () => facts,
      defaultDir: '/downloads',
      showSaveDialog: async () => ({ canceled: false, filePath: '/chosen/bundle.tar.gz' }),
      create: async () => {
        throw new Error(
          'Support bundle aborted: logs/main.log still contains "/Users/example-user".'
        )
      },
      log: { warn }
    })

    await expect(owner.exportBundle(sender)).resolves.toEqual({
      exported: false,
      error: 'Support bundle aborted: logs/main.log still contains "/Users/example-user".'
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('stamps a distinct default file name per export', async () => {
    const seen: string[] = []
    const owner = createSupportBundleCommandOwner({
      getLogDir: () => '/logs',
      getFacts: () => facts,
      defaultDir: '/downloads',
      showSaveDialog: async (_sender, options) => {
        seen.push(String(options?.defaultPath))
        return { canceled: true, filePath: '' }
      },
      create: vi.fn(),
      now: () => new Date('2026-09-28T12:34:56.000Z')
    })

    await owner.exportBundle(sender)

    // The stamp uses local time on purpose (it is read by the person saving the file), so assert its shape
    // rather than a value that would only hold in the CI timezone.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^\/downloads\/support-bundle-\d{8}-\d{6}\.tar\.gz$/)
  })
})
