import { describe, expect, it, vi } from 'vitest'

// The window reaches these five channels through `ipcMain`, and nothing else registers them. The failure this file
// exists for is a silent one: the channel is in the contract catalog, the composition routes it for the Web view and
// the command line, the renderer calls it — and a real window answers "No handler registered". That is what the
// packaged certification lane found on the home page's shelf read, so the channels are pinned here by name.

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
    handlers.set(channel, listener)
  }
}))

const { CASE_BUNDLE_IPC, registerCaseBundleIpcHandlers } = await import('./ipc')
const { RENDERER_CONTRACT_CATALOG } = await import('../../shared/renderer-contract-catalog')

type Owner = {
  export: ReturnType<typeof vi.fn>
  import: ReturnType<typeof vi.fn>
  marketplace: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
}

const owner = (): Owner => ({
  export: vi.fn(async () => ({ status: 'refused' as const, reason: 'no-files' as const })),
  import: vi.fn(async () => ({ status: 'refused' as const, reason: 'missing-manifest' as const })),
  marketplace: vi.fn(async () => ({ status: 'unreachable' as const })),
  install: vi.fn(async () => ({ status: 'refused' as const, reason: 'unreachable' as const })),
  publish: vi.fn(async () => ({ status: 'refused' as const, reason: 'no-credential' as const }))
})

describe('the window reach of a case bundle', () => {
  it('registers a handler for every case channel the contract catalog puts on the desktop', () => {
    handlers.clear()
    registerCaseBundleIpcHandlers(owner())

    const declared = RENDERER_CONTRACT_CATALOG.filter(
      (contract) =>
        contract.channel !== null &&
        contract.publicPath.startsWith('caseBundles.') &&
        contract.surfaceInstallation.electron !== undefined &&
        contract.surfaceInstallation.electron !== null
    ).map((contract) => contract.channel as string)

    expect(declared.length, 'the catalog must declare the case channels').toBeGreaterThan(0)
    for (const channel of declared) {
      expect(handlers.has(channel), `${channel} has no ipcMain handler`).toBe(true)
    }
    expect([...handlers.keys()].sort()).toEqual(Object.values(CASE_BUNDLE_IPC).sort())
  })

  it('hands each channel its request untouched and returns the owner answer', async () => {
    handlers.clear()
    const target = owner()
    registerCaseBundleIpcHandlers(target)

    const calls: Array<[string, keyof Owner, unknown]> = [
      [
        CASE_BUNDLE_IPC.EXPORT,
        'export',
        { projectId: 'p1', caseName: 'c', domain: 'd', destinationDir: '/tmp/x' }
      ],
      [CASE_BUNDLE_IPC.IMPORT, 'import', { bundleDir: '/tmp/b' }],
      [CASE_BUNDLE_IPC.MARKETPLACE, 'marketplace', {}],
      [CASE_BUNDLE_IPC.INSTALL, 'install', { entry: { id: 'x' } }],
      [CASE_BUNDLE_IPC.PUBLISH, 'publish', { projectId: 'p1', draft: { id: 'x' } }]
    ]
    for (const [channel, method, request] of calls) {
      const answer = await handlers.get(channel)!({}, request)
      expect(target[method]).toHaveBeenCalledWith(request)
      expect(answer).toEqual(await target[method].mock.results[0].value)
    }
  })
})
