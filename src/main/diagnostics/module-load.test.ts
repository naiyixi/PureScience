import { describe, expect, it, vi } from 'vitest'

import { createApplicationModuleLoader, type ApplicationModuleFailure } from './module-load'

const raiser = (): never => {
  throw Object.assign(new Error('Cannot find module'), { code: 'ENOENT' })
}

describe('application module loader', () => {
  it('returns the module and reports nothing when the import resolves', async () => {
    const onFailure = vi.fn<(failure: ApplicationModuleFailure) => void>()
    const loader = createApplicationModuleLoader({ onFailure })

    await expect(loader.load('./tray', async () => ({ created: 1 }))).resolves.toEqual({
      created: 1
    })
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('names the module and keeps the thrown error as the one the caller sees', async () => {
    const onFailure = vi.fn<(failure: ApplicationModuleFailure) => void>()
    const loader = createApplicationModuleLoader({ onFailure })
    const original = Object.assign(new Error('Cannot find module'), { code: 'ENOENT' })

    await expect(
      loader.load('./projects/prisma-client', async () => {
        throw original
      })
    ).rejects.toBe(original)

    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure.mock.calls[0]![0]).toMatchObject({
      module: './projects/prisma-client',
      errorCategory: 'not-found',
      errorName: 'Error'
    })
  })

  it('projects frames to basenames so no directory from this machine reaches the record', async () => {
    const onFailure = vi.fn<(failure: ApplicationModuleFailure) => void>()
    const loader = createApplicationModuleLoader({ onFailure })

    await expect(loader.load('./ipc', async () => raiser())).rejects.toThrow('Cannot find module')

    const reported = onFailure.mock.calls[0]![0]!
    expect(reported.frame).not.toMatch(/[/\\]/)
    expect(reported.origin).not.toMatch(/[/\\]/)
    expect(JSON.stringify(reported)).not.toContain(process.cwd())
    expect(reported.origin).not.toBe('unavailable')
  })

  it('never replaces the failure with the reporter’s own error', async () => {
    const original = new Error('module blew up')
    const loader = createApplicationModuleLoader({
      onFailure: () => {
        throw new Error('reporter failed')
      }
    })

    await expect(
      loader.load('./tray', async () => {
        throw original
      })
    ).rejects.toBe(original)
  })

  it('keeps free text out of the report while still naming the class of the failure', async () => {
    const onFailure = vi.fn<(failure: ApplicationModuleFailure) => void>()
    const loader = createApplicationModuleLoader({ onFailure })
    const secret = 'sk-live-SECRET /Users/example/private-study/patient.csv'
    const failure = new TypeError(secret)

    await expect(
      loader.load('./web-service', async () => {
        throw failure
      })
    ).rejects.toBe(failure)

    const reported = JSON.stringify(onFailure.mock.calls[0]![0])
    expect(reported).not.toContain('SECRET')
    expect(reported).not.toContain('private-study')
    expect(onFailure.mock.calls[0]![0]).toMatchObject({
      errorName: 'TypeError',
      errorCategory: 'type'
    })
  })
})
