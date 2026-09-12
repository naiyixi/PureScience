// The data-execution admission must honour the runtime the user persisted in Settings: with no
// session binding, a chosen external interpreter is adopted instead of silently provisioning the
// managed env (previously the selection was only readable by Settings, so "chosen" had no effect on
// execution and the managed bundle download was attempted regardless).

import { describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeSelection } from '../../shared/notebook-runtime'
import { NotebookDataExecutionAdmissionOwner } from './data-execution-admission'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import type { NotebookSessionAggregate, NotebookSessionRuntimeBinding } from './session-aggregate'

type AdmissionOptions = ConstructorParameters<typeof NotebookDataExecutionAdmissionOwner>[0]

const externalSelection: RuntimeSelection = {
  source: 'external',
  interpreterPath: '/Users/x/.cache/purescience/md-venv/bin/python',
  appOwnedOverlay: false,
  packageInstallAuthorized: true
}

const externalBinding = (): NotebookSessionRuntimeBinding => ({
  language: 'python',
  runtimeId: 'python-external-id',
  source: 'external',
  provenance: 'user-own',
  interpreterPath: externalSelection.source === 'external' ? externalSelection.interpreterPath : '',
  label: 'md-venv',
  status: 'active',
  resolvedInterpreter: { command: '/Users/x/.cache/purescience/md-venv/bin/python' }
})

const harness = (
  overrides: Partial<AdmissionOptions> = {},
  binding: NotebookSessionRuntimeBinding | undefined = undefined
): { owner: NotebookDataExecutionAdmissionOwner; options: AdmissionOptions; session: unknown } => {
  const session = {
    runtimeRoot: '/runtime',
    cwd: '/tmp/project',
    runtimeBinding: vi.fn((): NotebookSessionRuntimeBinding | undefined => binding)
  }
  const options: AdmissionOptions = {
    runtimeRoot: '/runtime',
    environmentOperations: {
      ensureDefaultEnvironmentReady: vi.fn(async () => undefined),
      isRepairBlocked: vi.fn(() => false),
      runShared: vi.fn()
    } as unknown as AdmissionOptions['environmentOperations'],
    recovery: {
      isGloballyBlocked: vi.fn(() => false),
      isPrefixBlocked: vi.fn(() => false),
      isRuntimeIdBlocked: vi.fn(() => false)
    },
    ensureRecovered: vi.fn(async () => undefined),
    resolveRuntimeEnablement: vi.fn(async () => ({ enabled: {}, installAuthorized: {} })),
    repairPolicy: new NotebookRuntimeRepairPolicy('/runtime'),
    ...overrides
  }
  return { owner: new NotebookDataExecutionAdmissionOwner(options), options, session }
}

const cell = (
  language: NotebookLanguage = 'python'
): { id: string; language: NotebookLanguage; code: string } => ({
  id: 'cell-1',
  language,
  code: 'print(1)'
})

const admit = (
  owner: NotebookDataExecutionAdmissionOwner,
  session: unknown
): ReturnType<NotebookDataExecutionAdmissionOwner['admit']> =>
  owner.admit(session as NotebookSessionAggregate, cell() as never)

describe('data-execution admission — persisted runtime selection', () => {
  it('adopts a selected external runtime instead of provisioning the managed default', async () => {
    const adoptRuntimeSelection = vi.fn(async () => externalBinding())
    const { owner, options, session } = harness({
      resolveRuntimeSelection: vi.fn(async () => externalSelection),
      adoptRuntimeSelection
    })

    const admission = await admit(owner, session)

    expect(adoptRuntimeSelection).toHaveBeenCalledTimes(1)
    expect(admission.binding?.source).toBe('external')
    expect(admission.resolvedInterpreter).toEqual({
      command: '/Users/x/.cache/purescience/md-venv/bin/python'
    })
    expect(admission.rejection).toBeUndefined()
    // The whole point: no managed env provisioning/download is attempted.
    expect(options.environmentOperations.ensureDefaultEnvironmentReady).not.toHaveBeenCalled()
  })

  it('keeps the managed default when nothing was selected', async () => {
    const adoptRuntimeSelection = vi.fn(async () => externalBinding())
    const { owner, options, session } = harness({
      resolveRuntimeSelection: vi.fn(async () => undefined),
      adoptRuntimeSelection
    })

    const admission = await admit(owner, session)

    expect(adoptRuntimeSelection).not.toHaveBeenCalled()
    expect(admission.binding).toBeUndefined()
    expect(options.environmentOperations.ensureDefaultEnvironmentReady).toHaveBeenCalledTimes(1)
  })

  it('keeps the managed default when the selection is managed', async () => {
    const adoptRuntimeSelection = vi.fn(async () => externalBinding())
    const { owner, options, session } = harness({
      resolveRuntimeSelection: vi.fn(async () => ({ source: 'managed' }) as RuntimeSelection),
      adoptRuntimeSelection
    })

    const admission = await admit(owner, session)

    expect(adoptRuntimeSelection).not.toHaveBeenCalled()
    expect(admission.binding).toBeUndefined()
    expect(options.environmentOperations.ensureDefaultEnvironmentReady).toHaveBeenCalledTimes(1)
  })

  it('never re-binds a session that already has a binding', async () => {
    const adoptRuntimeSelection = vi.fn(async () => externalBinding())
    const resolveRuntimeSelection = vi.fn(async () => externalSelection)
    const { owner, options, session } = harness(
      { resolveRuntimeSelection, adoptRuntimeSelection },
      externalBinding()
    )

    const admission = await admit(owner, session)

    expect(resolveRuntimeSelection).not.toHaveBeenCalled()
    expect(adoptRuntimeSelection).not.toHaveBeenCalled()
    expect(admission.binding?.source).toBe('external')
    expect(options.environmentOperations.ensureDefaultEnvironmentReady).not.toHaveBeenCalled()
  })

  it('explains the fallback when the selected runtime cannot be adopted', async () => {
    const { owner, session } = harness({
      resolveRuntimeSelection: vi.fn(async () => externalSelection),
      adoptRuntimeSelection: vi.fn(async () => undefined),
      repairPolicy: new NotebookRuntimeRepairPolicy('/runtime'),
      environmentOperations: {
        ensureDefaultEnvironmentReady: vi.fn(async () => {
          throw new Error(
            'DEFAULT_RUNTIME_NOT_READY: the app-managed python runtime is not prepared.'
          )
        }),
        isRepairBlocked: vi.fn(() => false),
        runShared: vi.fn()
      } as unknown as AdmissionOptions['environmentOperations']
    })

    const admission = await admit(owner, session)

    expect(admission.rejection).toBeInstanceOf(Error)
    const message = (admission.rejection as Error).message
    expect(message).toContain('DEFAULT_RUNTIME_NOT_READY')
    expect(message).toContain('could not be bound')
    expect(message).toContain('md-venv/bin/python')
  })
})
