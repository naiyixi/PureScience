import { basename, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  createSupportBundleCommandOwner,
  resolveDefaultSaveDirectory,
  type SupportBundleFacts
} from './support-bundle-ipc'

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
      getDefaultDir: () => '/downloads',
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

  it('falls back through the path candidates when one cannot be resolved', () => {
    const attempts: string[] = []
    const resolved = resolveDefaultSaveDirectory((name) => {
      attempts.push(name)
      if (name === 'downloads') throw new Error("Failed to get 'downloads' path")
      return `/home/user/${name}`
    })

    expect(resolved).toBe('/home/user/home')
    expect(attempts).toEqual(['downloads', 'home'])
  })

  it('reports no default directory when none of the candidates resolve', () => {
    expect(
      resolveDefaultSaveDirectory(() => {
        throw new Error('unavailable')
      })
    ).toBeUndefined()
  })

  it('reports a cancel as "nothing exported" rather than an error, and writes nothing', async () => {
    const create = vi.fn()
    const owner = createSupportBundleCommandOwner({
      getLogDir: () => '/logs',
      getFacts: () => facts,
      getDefaultDir: () => '/downloads',
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
      getDefaultDir: () => '/downloads',
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

  it('still exports when the default directory cannot be resolved', async () => {
    const create = vi.fn(async (input: { outPath: string }) => ({
      path: input.outPath,
      bytes: 1,
      redactions: 0
    }))
    const seen: Array<Record<string, unknown>> = []
    const owner = createSupportBundleCommandOwner({
      getLogDir: () => '/logs',
      getFacts: () => facts,
      // `app.getPath('downloads')` throws on a fresh Windows profile; the export must survive it.
      getDefaultDir: () => {
        throw new Error("Failed to get 'downloads' path")
      },
      showSaveDialog: async (_sender, options) => {
        seen.push(options as Record<string, unknown>)
        return { canceled: false, filePath: '/chosen/bundle.tar.gz' }
      },
      create
    })

    await expect(owner.exportBundle(sender)).resolves.toMatchObject({ exported: true })
    // No default path at all, rather than a broken one: the dialog opens wherever the platform prefers.
    expect(seen[0]?.defaultPath).toBeUndefined()
  })

  it('stamps a distinct default file name per export', async () => {
    const seen: string[] = []
    const owner = createSupportBundleCommandOwner({
      getLogDir: () => '/logs',
      getFacts: () => facts,
      getDefaultDir: () => '/downloads',
      showSaveDialog: async (_sender, options) => {
        seen.push(String(options?.defaultPath))
        return { canceled: true, filePath: '' }
      },
      create: vi.fn(),
      now: () => new Date('2026-09-28T12:34:56.000Z')
    })

    await owner.exportBundle(sender)

    // Two things are asserted separately because neither is portable on its own: the stamp uses local time
    // on purpose (it is read by the person saving the file, so a fixed value would only hold in one
    // timezone), and the separator differs by platform (a literal '/downloads/...' pattern fails on Windows,
    // which is how this test first went red).
    expect(seen).toHaveLength(1)
    expect(seen[0].startsWith(join('/downloads', ''))).toBe(true)
    expect(basename(seen[0])).toMatch(/^support-bundle-\d{8}-\d{6}\.tar\.gz$/)
  })
})
