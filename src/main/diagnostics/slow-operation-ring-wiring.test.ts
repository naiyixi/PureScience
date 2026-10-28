import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createApplicationCommandRouter,
  defineApplicationCommand,
  defineApplicationCommandGroup
} from '../application-command-router'
import { createCallerContext } from '../caller-context'
import { invokeWithIpcRejectionDiagnostics } from './ipc-rejection'
import { sharedSlowOperations } from './slow-operation-ring'

// Both producers default their sink to the process-wide ring, and the composition root reads that same ring
// into the support bundle. The failure this guards is the shape this codebase has already paid for twice:
// both halves work, the seam between them was never made, and the artifact a user sends carries nothing —
// which reads exactly like an application that was never slow.
//
// It lives in its own file because the ring is process-wide: sharing a file with the producers' own cases
// would let their records answer for these.

const callerContext = createCallerContext({
  clientId: 'web-client',
  lifecycleClientId: 'web:web-client',
  leaseId: 'lease-1',
  surface: 'web',
  location: 'remote',
  principalKind: 'human',
  actionOrigin: 'human'
})

afterEach(() => {
  sharedSlowOperations.clear()
})

describe('slow-operation ring (default wiring)', () => {
  it('records an IPC handler that nobody handed a sink to', async () => {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(700)

    await invokeWithIpcRejectionDiagnostics({
      channel: 'sessions:read-document',
      callerContext,
      invoke: async () => 'document',
      log: { warn: vi.fn() },
      now
    })

    const summary = sharedSlowOperations.summary()
    expect(summary.observed).toBe(1)
    expect(summary.records[0]).toMatchObject({
      kind: 'ipc',
      name: 'sessions:read-document',
      surface: 'web',
      durationMs: 700
    })
  })

  it('records an application command that nobody handed a sink to', async () => {
    const readValue = defineApplicationCommand<'sample.read', readonly [id: string], string>(
      'sample.read'
    )
    const router = createApplicationCommandRouter()
    const scope = router.registrar.createScope()
    scope.registerGroup(defineApplicationCommandGroup('read', [readValue] as const), {
      'sample.read': () => Promise.resolve('ok')
    })
    const clock = vi.spyOn(Date, 'now')

    clock.mockReturnValueOnce(1_000).mockReturnValueOnce(1_300)
    await router.dispatcher.invoke(readValue, {
      callerContext,
      callerLease: {
        leaseId: 'lease-1',
        generation: 1,
        signal: new AbortController().signal,
        isCurrent: () => true
      },
      args: ['id-1'] as const
    })
    clock.mockRestore()

    const summary = sharedSlowOperations.summary()
    expect(summary.observed).toBe(1)
    expect(summary.records[0]).toMatchObject({
      kind: 'command',
      name: 'sample.read',
      code: 'slow-handler',
      durationMs: 300
    })
  })

  it('reads the ring in the composition root and writes it into the bundle', () => {
    // Source-level on purpose: this is a seam between two modules that never import each other, and the
    // alternative — an integration case that builds the whole main process — is not what is missing here.
    const projectRoot = resolve(__dirname, '../../..')
    const compositionSource = readFileSync(resolve(projectRoot, 'src/main/ipc.ts'), 'utf8')
    const bundleSource = readFileSync(
      resolve(projectRoot, 'src/main/diagnostics/support-bundle.ts'),
      'utf8'
    )

    expect(compositionSource).toContain("from './diagnostics/slow-operation-ring'")
    // The bundle's facts must actually carry it: a ring nobody reads is a reading the user never receives.
    expect(compositionSource).toContain('slowOperations: sharedSlowOperations.summary()')
    expect(bundleSource).toContain("'diagnostics/slow-operations.json'")
  })
})
