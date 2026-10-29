import { describe, expect, it, vi } from 'vitest'

import type { ExportSessionPackageRequest } from '../../shared/session-package'
import type { SessionPackageImportRequest } from '../../shared/session-package-import'
import {
  createApplicationCommandRouter,
  type ApplicationInvocation
} from '../application-command-router'
import { createCallerContext } from '../caller-context'
import {
  registerSessionPackageApplicationCommands,
  sessionPackageApplicationCommandGroup,
  type SessionPackageCommandOwner
} from './application-commands'

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  location: 'local' | 'remote' = 'local'
): ApplicationInvocation<Args> => {
  const callerContext = createCallerContext({
    clientId: 'web-client',
    lifecycleClientId: 'web:web-client',
    leaseId: 'lease-1',
    surface: 'web',
    location,
    principalKind: 'human',
    actionOrigin: 'human'
  })
  return Object.freeze({
    callerContext,
    callerLease: Object.freeze({
      leaseId: callerContext.leaseId,
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: (): boolean => true
    }),
    args
  })
}

const owner = (
  overrides: Partial<SessionPackageCommandOwner> = {}
): SessionPackageCommandOwner => ({
  exportPackage: vi.fn(async () => ({
    ok: true as const,
    path: '/tmp/session.science',
    bytes: 128,
    notes: []
  })),
  importPackage: vi.fn(async () => ({
    ok: true as const,
    sessionId: 'imported-1',
    posture: {
      readOnly: true as const,
      executeAllowed: false as const,
      continueAllowed: false as const,
      verificationLabel: 'source-party' as const
    },
    notes: [],
    readings: {
      usage: {
        state: 'match' as const,
        derived: { turns: 2, inputTokens: 0, outputTokens: 0, turnsWithoutUsage: 0 }
      },
      toolCalls: { state: 'not-recorded' as const }
    },
    landed: {
      citations: 0,
      reviews: 0,
      reviewFindings: 0,
      verificationRecords: 0,
      skipped: []
    }
  })),
  ...overrides
})

describe('session package application commands', () => {
  it('exposes exactly the two package directions', () => {
    expect(sessionPackageApplicationCommandGroup.name).toBe('session-package')
    expect(sessionPackageApplicationCommandGroup.commands.map(({ name }) => name).sort()).toEqual([
      'sessions:export-package',
      'sessions:import-package'
    ])
  })

  it('delegates both directions to the owner with the caller request verbatim', async () => {
    const dependencies = owner()
    const router = createApplicationCommandRouter()
    registerSessionPackageApplicationCommands(router.registrar, dependencies)
    const exportRequest: ExportSessionPackageRequest = {
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'full',
      destinationPath: '/tmp/out.science'
    }
    const importRequest: SessionPackageImportRequest = {
      packagePath: '/tmp/in.science',
      confirm: { targetProjectId: 'project-1' }
    }

    await expect(
      router.dispatcher.invoke(
        sessionPackageApplicationCommandGroup.commands[0]!,
        invocation([exportRequest])
      )
    ).resolves.toMatchObject({ ok: true, bytes: 128 })
    await expect(
      router.dispatcher.invoke(
        sessionPackageApplicationCommandGroup.commands[1]!,
        invocation([importRequest])
      )
    ).resolves.toMatchObject({ ok: true, sessionId: 'imported-1' })

    expect(dependencies.exportPackage).toHaveBeenCalledWith(exportRequest)
    expect(dependencies.importPackage).toHaveBeenCalledWith(importRequest)
    // No per-call dialog reaches the owner from this surface: a Web caller names a path or is refused.
    expect(vi.mocked(dependencies.exportPackage).mock.calls[0]).toHaveLength(1)
    router.dispose()
  })

  it('passes a named refusal through instead of throwing', async () => {
    const dependencies = owner({
      exportPackage: vi.fn(async () => ({ ok: false as const, error: 'no-destination' as const })),
      importPackage: vi.fn(async () => ({ ok: false as const, reason: 'not-a-package' as const }))
    })
    const router = createApplicationCommandRouter()
    registerSessionPackageApplicationCommands(router.registrar, dependencies)

    await expect(
      router.dispatcher.invoke(
        sessionPackageApplicationCommandGroup.commands[0]!,
        invocation([{ projectId: 'project-1', sessionId: 'session-1', mode: 'essential' }])
      )
    ).resolves.toEqual({ ok: false, error: 'no-destination' })
    await expect(
      router.dispatcher.invoke(
        sessionPackageApplicationCommandGroup.commands[1]!,
        invocation([{ packagePath: '/tmp/in.science' }])
      )
    ).resolves.toEqual({ ok: false, reason: 'not-a-package' })
    router.dispose()
  })

  it('unregisters cleanly', () => {
    const router = createApplicationCommandRouter()
    const installation = registerSessionPackageApplicationCommands(router.registrar, owner())
    expect(router.dispatcher.commandNames()).toHaveLength(2)
    installation.uninstall()
    expect(router.dispatcher.commandNames()).toHaveLength(0)
    router.dispose()
  })
})
