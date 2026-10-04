// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProvisionStatus } from '../../../../shared/notebook-env'
import type {
  DiscoveredInterpreter,
  EnvPackage,
  RuntimeEnablement
} from '../../../../shared/notebook-runtime'
import { createInitialNotebookEnvState, useNotebookEnvStore } from '@/stores/notebook-env-store'
import { formatProgressLine } from '../../../../shared/download-progress'
import { RuntimesPanel } from './RuntimesPanel'

let container: HTMLDivElement
let root: Root

const pythonEnvs: DiscoveredInterpreter[] = [
  {
    language: 'python',
    provenance: 'app-managed',
    envId: '/data/runtime/envs/default-python-3.12/bin/python',
    interpreterPath: '/data/runtime/envs/default-python-3.12/bin/python',
    label: 'Python 3.12 (managed)',
    version: '3.12.4',
    runnable: true
  },
  {
    language: 'python',
    provenance: 'user-own',
    envId: '/usr/bin/python3',
    interpreterPath: '/usr/bin/python3',
    label: 'System Python',
    version: '3.11.2',
    runnable: true
  }
]

const rEnvs: DiscoveredInterpreter[] = [
  {
    language: 'r',
    provenance: 'user-own',
    envId: '/opt/conda/envs/bio/bin/R',
    interpreterPath: '/opt/conda/envs/bio/bin/R',
    label: 'R 4.4.1',
    version: 'R 4.4.1',
    runnable: false,
    condaEnv: 'bio',
    detail: 'Needs jsonlite'
  }
]

let listEnvironments: ReturnType<typeof vi.fn>
let listPackages: ReturnType<typeof vi.fn>
let listPackageCounts: ReturnType<typeof vi.fn>
let getEnablement: ReturnType<typeof vi.fn>
let describeUsage: ReturnType<typeof vi.fn>
let setEnvironmentEnabled: ReturnType<typeof vi.fn>
let setInstallAuthorized: ReturnType<typeof vi.fn>
let registerInterpreter: ReturnType<typeof vi.fn>
let pickInterpreter: ReturnType<typeof vi.fn>
let importLock: ReturnType<typeof vi.fn>
let manageNamedEnvironments: ReturnType<typeof vi.fn>
let managePackages: ReturnType<typeof vi.fn>
let provision: ReturnType<typeof vi.fn>
let cancelBridge: ReturnType<typeof vi.fn>
let repairBridge: ReturnType<typeof vi.fn>

const provisionStatus: ProvisionStatus = {
  pythonReady: false,
  rReady: false,
  version: 0,
  provisioning: false
}

const enablement: RuntimeEnablement = { enabled: {}, installAuthorized: {} }

beforeEach(() => {
  useNotebookEnvStore.setState(createInitialNotebookEnvState())
  listEnvironments = vi.fn().mockResolvedValue({ python: pythonEnvs, r: rEnvs })
  listPackages = vi
    .fn()
    .mockImplementation(async (_language: string, envId: string): Promise<EnvPackage[]> => {
      if (envId === '/usr/bin/python3') return [{ name: 'requests', version: '2.32.3' }]
      return [
        { name: 'numpy', version: '2.1.3', build: 'py312hb2f4e1b_0', channel: 'conda-forge' },
        { name: 'pandas', version: '2.2.3', build: 'py312h1234567_0', channel: 'conda-forge' }
      ]
    })
  listPackageCounts = vi
    .fn()
    .mockImplementation(async (language: string): Promise<Record<string, number | null>> =>
      language === 'python'
        ? {
            '/data/runtime/envs/default-python-3.12/bin/python': 2,
            '/usr/bin/python3': 1
          }
        : {}
    )
  getEnablement = vi.fn().mockResolvedValue(enablement)
  describeUsage = vi.fn().mockResolvedValue({ running: 0, idle: 0, dormant: 0 })
  setEnvironmentEnabled = vi
    .fn()
    .mockImplementation(async (_language: string, envId: string, enabled: boolean) => ({
      enabled: { ...enablement.enabled, [envId]: enabled },
      installAuthorized: { ...enablement.installAuthorized }
    }))
  setInstallAuthorized = vi
    .fn()
    .mockImplementation(async (_language: string, envId: string, authorized: boolean) => ({
      enabled: { ...enablement.enabled },
      installAuthorized: { ...enablement.installAuthorized, [envId]: authorized }
    }))
  registerInterpreter = vi.fn().mockResolvedValue(['/usr/bin/python3'])
  pickInterpreter = vi.fn().mockResolvedValue('/usr/bin/python3')
  importLock = vi.fn().mockResolvedValue({
    status: 'imported',
    environment: { name: 'lock-env', language: 'python', ready: true, isDefault: false },
    coverage: { total: 2, fromCache: 1, downloaded: 1, missing: [] }
  })
  // Audit P0-8: the panel lists named environments on mount, so the double must answer that call.
  manageNamedEnvironments = vi.fn().mockResolvedValue({ environments: [] })
  provision = vi.fn().mockRejectedValue(new Error('runtime CDN unavailable'))
  // IC13: default to "the gate allowed it"; the tests that care about a refusal override this.
  managePackages = vi.fn().mockResolvedValue({ ok: true, needsRestart: false, log: '' })
  cancelBridge = vi.fn().mockResolvedValue(undefined)
  repairBridge = vi.fn().mockResolvedValue(undefined)
  ;(window as unknown as { api: unknown }).api = {
    runtime: {
      listEnvironments,
      listPackages,
      managePackages,
      listPackageCounts,
      getEnablement,
      describeUsage,
      setEnvironmentEnabled,
      setInstallAuthorized,
      registerInterpreter,
      pickInterpreter,
      importLock,
      manageNamedEnvironments,
      // The panel now loads the persisted selection up front so it can mark the current runtime.
      survey: vi.fn().mockResolvedValue([])
    },
    notebookEnv: {
      getStatus: vi.fn().mockResolvedValue(provisionStatus),
      onProgress: vi.fn(),
      provision,
      cancel: cancelBridge,
      repair: repairBridge
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

const render = async (
  title = 'Notebook runtimes',
  description = 'Enable the environments each notebook language may run in.'
): Promise<void> => {
  await act(async () => {
    root.render(<RuntimesPanel title={title} description={description} />)
  })
  // Flush the listEnvironments()/survey() microtasks.
  await act(async () => {})
  await act(async () => {})
}

const click = async (el: Element | null): Promise<void> => {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('RuntimesPanel', () => {
  it('renders caller-provided heading copy with Recheck in the same top section', async () => {
    await render('Custom runtime title', 'Custom runtime description')

    const section = container.querySelector('section[aria-label="Custom runtime title"]')
    expect(section?.querySelector('h3')?.textContent).toBe('Custom runtime title')
    expect(section?.textContent).toContain('Custom runtime description')
    const recheck = section?.querySelector<HTMLButtonElement>('button')
    expect(recheck?.textContent).toContain('Recheck')
    expect(recheck?.parentElement?.className).toContain('ml-auto')
  })

  it('renders a card per detected env with version and interpreter path', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('Python 3.12 (managed)')
    expect(text).toContain('3.12.4')
    expect(text).toContain('/data/runtime/envs/default-python-3.12/bin/python')
    expect(text).toContain('System Python')
    expect(text).toContain('/usr/bin/python3')
    // R conda env card, including its provider/type and readiness gap.
    expect(text).toContain('R 4.4.1')
    expect(text).toContain('Conda: bio')
    expect(text).toContain('Needs jsonlite')
    // One card per detected env, plus a first-position app-managed setup card for the language whose
    // managed env is not provisioned yet (R here): python (managed 3.12 + System) + R (managed setup +
    // R 4.4.1) = 4 cards.
    expect(container.querySelectorAll('[data-testid="runtime-card"]').length).toBe(4)
  })

  it('uses the theme color for Python and R managed-runtime actions', async () => {
    // Remove both managed interpreters so each language exposes the same setup action.
    listEnvironments.mockResolvedValue({ python: pythonEnvs.slice(1), r: rEnvs })
    await render()

    for (const language of ['Python', 'R']) {
      const section = container.querySelector(`section[aria-label="${language} runtime"]`)
      const setupButton = Array.from(section?.querySelectorAll('button') ?? []).find((button) =>
        /download and set up/i.test(button.textContent ?? '')
      )

      expect(setupButton?.getAttribute('data-variant')).toBe('default')
    }
  })

  it('enable toggle calls setEnvironmentEnabled with the env id', async () => {
    await render()
    const toggle = container.querySelector<HTMLElement>('[aria-label="Enable System Python"]')
    await click(toggle)
    // user-own defaults OFF, so toggling turns it ON (no force on enable).
    expect(setEnvironmentEnabled).toHaveBeenCalledWith(
      'python',
      '/usr/bin/python3',
      true,
      undefined
    )
  })

  it('defaults user-own envs to disabled and app-managed to enabled', async () => {
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')
    const userToggle = container.querySelector('[aria-label="Enable System Python"]')
    expect(managedToggle?.getAttribute('data-state')).toBe('checked')
    expect(userToggle?.getAttribute('data-state')).toBe('unchecked')
  })

  it('surfaces the "cannot disable the last enabled runtime" error inline', async () => {
    setEnvironmentEnabled.mockRejectedValueOnce(
      new Error('Cannot disable the last enabled runtime for python.')
    )
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')
    await click(managedToggle)
    expect(container.querySelector('[data-testid="runtimes-error"]')?.textContent).toContain(
      'Cannot disable the last enabled runtime'
    )
  })

  it('warns before disabling a runtime that live sessions are using, then applies on confirm (WS11)', async () => {
    describeUsage.mockResolvedValue({ running: 1, idle: 0, dormant: 0 })
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')
    await click(managedToggle)

    // The impact dialog is shown and the disable is NOT applied yet.
    const dialog = document.querySelector('[data-testid="disable-impact-dialog"]')
    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('1 running')
    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(overlay?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(overlay?.className).not.toContain('backdrop-blur')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(setEnvironmentEnabled).not.toHaveBeenCalled()

    // Confirming applies the disable to the bound runtime.
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      /disable after current work/i.test(b.textContent ?? '')
    )
    await click(confirmBtn ?? null)
    // "Disable after current work" = drain (no force).
    expect(setEnvironmentEnabled).toHaveBeenCalledWith(
      'python',
      '/data/runtime/envs/default-python-3.12/bin/python',
      false,
      undefined
    )
  })

  it('offers force-stop when a cell is running and disables with force on confirm (WS10)', async () => {
    describeUsage.mockResolvedValue({ running: 1, idle: 0, dormant: 0 })
    await render()
    const managedToggle = container.querySelector('[aria-label="Enable Python 3.12 (managed)"]')
    await click(managedToggle)

    // With a running cell, the dialog offers "Stop running work" (force-stop).
    const forceBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      /stop running work/i.test(b.textContent ?? '')
    )
    expect(forceBtn).toBeDefined()
    await click(forceBtn ?? null)
    expect(setEnvironmentEnabled).toHaveBeenCalledWith(
      'python',
      '/data/runtime/envs/default-python-3.12/bin/python',
      false,
      true
    )
  })

  it('exposes app-managed acquisition with a failed CDN attempt and retry affordance', async () => {
    await render()
    const setupBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /download and set up/i.test(b.textContent ?? '')
    )
    await click(setupBtn ?? null)
    expect(provision).toHaveBeenCalledWith('r', expect.any(String))
    // The failure surfaces on R's OWN card (per-language error), and its button offers a retry.
    expect(
      container.querySelector('[data-testid="runtimes-provision-error-r"]')?.textContent
    ).toContain('runtime CDN unavailable')
    const retryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /^retry setup$/i.test((button.textContent ?? '').trim())
    )
    expect(retryButton?.getAttribute('data-variant')).toBe('default')
  })

  it('adds an interpreter via the picker and enables the new external env', async () => {
    await render()
    const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /add interpreter/i.test(b.textContent ?? '')
    )
    // First matching Add button is Python's.
    await click(addBtn ?? null)
    expect(pickInterpreter).toHaveBeenCalledOnce()
    // The picked path is added to the discovery catalog (not the removed setSelection path).
    expect(registerInterpreter).toHaveBeenCalledWith('python', '/usr/bin/python3')
    // The picked path matches a detected env, so it is enabled (Add-interpreter's direct 3-arg call).
    expect(setEnvironmentEnabled).toHaveBeenCalledWith('python', '/usr/bin/python3', true)
  })

  it('shows a clear local-desktop message when remote runtime management is restricted', async () => {
    pickInterpreter.mockRejectedValueOnce(
      new Error(
        'This action is only available in the local desktop app (runtime:pick-interpreter).'
      )
    )
    await render()
    const addBtn = Array.from(container.querySelectorAll('button')).find((button) =>
      /add interpreter/i.test(button.textContent ?? '')
    )

    await click(addBtn ?? null)

    expect(container.querySelector('[data-testid="runtimes-error"]')?.textContent).toContain(
      'only available in the local desktop app'
    )
    expect(registerInterpreter).not.toHaveBeenCalled()
  })

  it('shows a determinate progress bar + Cancel in the app-managed setup card while downloading', async () => {
    await render()
    // R has no provisioned managed env, so its section shows the app-managed SETUP card (which carries
    // the progress bar + Cancel). Drive the mirrored provisioning state into "preparing" at 30% for R.
    act(() =>
      useNotebookEnvStore.setState({
        byLang: {
          r: {
            preparing: true,
            progress: {
              phase: 'download',
              message: 'Downloading managed R runtime (30%)',
              progress: 0.3,
              language: 'r'
            }
          }
        }
      })
    )
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('aria-valuenow')).toBe('30')
    expect(container.textContent).toContain('Downloading managed R runtime (30%)')
    // The download is cancelable, not a locked state.
    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^cancel$/i.test((b.textContent ?? '').trim())
    )
    expect(cancelBtn).toBeDefined()
    await click(cancelBtn ?? null)
    expect(cancelBridge).toHaveBeenCalled()
  })

  it('shows the same download detail the workspace shows (speed / size / ETA) while setting up', async () => {
    const download = {
      phase: 'downloading' as const,
      transferred: 5_000_000,
      total: 16_000_000,
      percent: 31,
      bytesPerSecond: 1_000_000,
      etaSeconds: 11,
      attempt: 1
    }
    await render()
    act(() =>
      useNotebookEnvStore.setState({
        byLang: {
          r: {
            preparing: true,
            progress: {
              phase: 'download',
              message: 'Downloading managed R runtime',
              progress: 0.31,
              language: 'r',
              download
            }
          }
        }
      })
    )
    // Asserted against the SHARED formatter's own output rather than a re-typed string: one source with the
    // workspace banner and the update dialog is exactly what "the same detail" has to mean.
    expect(container.textContent).toContain(formatProgressLine(download))
    expect(container.textContent).toContain('~11s')

    // A stalled transfer must read as resuming, not as a frozen 0 B/s — that is the resume half of IC17.
    const reconnecting = { ...download, phase: 'reconnecting' as const, attempt: 2 }
    act(() =>
      useNotebookEnvStore.setState({
        byLang: {
          r: {
            preparing: true,
            progress: {
              phase: 'download',
              message: 'Downloading managed R runtime',
              progress: 0.31,
              language: 'r',
              download: reconnecting
            }
          }
        }
      })
    )
    expect(container.textContent).toContain('resuming')
    expect(container.textContent).toContain('attempt 2')
  })

  it('surfaces Reset in the app-managed SETUP card when a language is recovery-blocked', async () => {
    await render()
    // R has no provisioned managed env -> its section shows the setup card. A recovery-blocked error
    // must turn the primary action into "Reset runtime" (not "Retry setup") wired to repair.
    act(() =>
      useNotebookEnvStore.setState({
        byLang: {
          r: {
            preparing: false,
            error: 'RUNTIME_RECOVERY_BLOCKED: a previous operation was interrupted'
          }
        }
      })
    )
    const resetBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^reset runtime$/i.test((b.textContent ?? '').trim())
    )
    expect(resetBtn).toBeDefined()
    expect(resetBtn?.getAttribute('data-variant')).toBe('default')
    await click(resetBtn ?? null)
    expect(repairBridge).toHaveBeenCalledWith('r', expect.any(String))
  })

  it('surfaces Reset even when a runnable managed env is still present (interrupted upgrade/install)', async () => {
    await render()
    // Python HAS a runnable app-managed env, so the normal card renders — but an interrupted
    // upgrade/install may have quarantined its prefix. The recovery entry must still be reachable, or
    // the user could never clear the block while the interpreter exists.
    act(() =>
      useNotebookEnvStore.setState({
        byLang: {
          python: {
            preparing: false,
            error: 'RUNTIME_RECOVERY_BLOCKED: a previous operation was interrupted'
          }
        }
      })
    )
    const notice = container.querySelector('[data-testid="runtimes-recovery-blocked-python"]')
    expect(notice).not.toBeNull()
    const resetBtn = Array.from(notice?.querySelectorAll('button') ?? []).find((b) =>
      /^reset runtime$/i.test((b.textContent ?? '').trim())
    )
    expect(resetBtn).toBeDefined()
    expect(resetBtn?.getAttribute('data-variant')).toBe('default')
    await click(resetBtn ?? null)
    expect(repairBridge).toHaveBeenCalledWith('python', expect.any(String))
  })

  it('keeps Cancel clickable while a real Download-and-set-up is in flight (not locked by busy)', async () => {
    // A provision that stays pending, so the setup is genuinely mid-flight when we look for Cancel.
    let resolveProvision: (() => void) | undefined
    provision.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveProvision = r
        })
    )
    await render()
    const downloadBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /download and set up/i.test(b.textContent ?? '')
    )
    await click(downloadBtn ?? null) // kicks off provision; provisioningLang set immediately

    // Download is replaced by an ENABLED Cancel (not a disabled, locked button).
    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^cancel$/i.test((b.textContent ?? '').trim())
    )
    expect(cancelBtn).toBeDefined()
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(false)
    await click(cancelBtn ?? null)
    expect(cancelBridge).toHaveBeenCalled()

    resolveProvision?.()
  })

  it('does not re-enable setup while refreshing environments after provision completes', async () => {
    let resolveRefresh:
      ((value: { python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }) => void) | undefined
    const installedR: DiscoveredInterpreter = {
      language: 'r',
      provenance: 'app-managed',
      envId: '/data/runtime/envs/default-r/bin/R',
      interpreterPath: '/data/runtime/envs/default-r/bin/R',
      label: 'R 4.4.3 (managed)',
      version: '4.4.3',
      runnable: true
    }
    provision.mockResolvedValue(undefined)
    listEnvironments.mockResolvedValueOnce({ python: pythonEnvs, r: rEnvs }).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    await render()

    const setupButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /download and set up/i.test(button.textContent ?? '')
    )
    await click(setupButton ?? null)

    const finishingButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /^finishing setup…$/i.test((button.textContent ?? '').trim())
    )
    const finishingDisabled = (finishingButton as HTMLButtonElement | undefined)?.disabled
    const setupWasReenabled = container.textContent?.includes('Download and set up')

    resolveRefresh?.({ python: pythonEnvs, r: [installedR, ...rEnvs] })
    await act(async () => {})

    expect(finishingButton).toBeDefined()
    expect(finishingDisabled).toBe(true)
    expect(setupWasReenabled).toBe(false)
    expect(container.textContent).toContain('R 4.4.3 (managed)')
  })
})

describe('RuntimesPanel packages dialog', () => {
  const setInputValue = (input: HTMLInputElement, value: string): void => {
    // React's onChange reads value via the synthetic event; the native setter bypasses its tracking.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const flush = async (): Promise<void> => {
    await act(async () => {})
    await act(async () => {})
  }

  const cardWith = (text: string): Element | undefined =>
    Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find((card) =>
      card.textContent?.includes(text)
    )

  it('shows a Packages button on runnable env cards only, then a count badge per env', async () => {
    await render()
    // Runnable: managed python + System Python. The non-runnable R conda card has no button.
    expect(
      cardWith('Python 3.12 (managed)')?.querySelector('[data-testid="runtime-packages-button"]')
    ).not.toBeNull()
    expect(
      cardWith('System Python')?.querySelector('[data-testid="runtime-packages-button"]')
    ).not.toBeNull()
    expect(cardWith('R 4.4.1')?.querySelector('[data-testid="runtime-packages-button"]')).toBeNull()

    // Counts land lazily after the panel loads: ONE bulk listPackageCounts call for python (the
    // only language with runnable envs here) — no per-env listPackages calls for badges.
    await flush()
    expect(listPackageCounts).toHaveBeenCalledWith('python')
    expect(listPackageCounts).toHaveBeenCalledTimes(1)
    expect(listPackageCounts).not.toHaveBeenCalledWith('r')
    expect(listPackages).not.toHaveBeenCalled()
    const managedBadge = cardWith('Python 3.12 (managed)')?.querySelector(
      '[data-testid="runtime-packages-count"]'
    )
    const systemBadge = cardWith('System Python')?.querySelector(
      '[data-testid="runtime-packages-count"]'
    )
    expect(managedBadge?.textContent).toBe('2')
    expect(systemBadge?.textContent).toBe('1')
  })

  it('omits the count badge when the bulk count fetch fails (no card-level error UI)', async () => {
    listPackageCounts.mockRejectedValue(new Error('discovery failed'))
    await render()
    await flush()
    expect(container.querySelector('[data-testid="runtime-packages-count"]')).toBeNull()
    expect(container.querySelector('[data-testid="runtimes-error"]')).toBeNull()
  })

  it('omits a badge for envs whose count came back null in the bulk response', async () => {
    listPackageCounts.mockResolvedValue({
      '/data/runtime/envs/default-python-3.12/bin/python': 2,
      '/usr/bin/python3': null
    })
    await render()
    await flush()
    expect(
      cardWith('Python 3.12 (managed)')?.querySelector('[data-testid="runtime-packages-count"]')
        ?.textContent
    ).toBe('2')
    expect(
      cardWith('System Python')?.querySelector('[data-testid="runtime-packages-count"]')
    ).toBeNull()
  })

  it('opens the dialog with package rows and conda columns, and the filter narrows rows', async () => {
    await render()
    await flush()
    const button = cardWith('Python 3.12 (managed)')?.querySelector(
      '[data-testid="runtime-packages-button"]'
    )
    await click(button ?? null)

    const dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Packages in Python 3.12 (managed)')
    expect(dialog?.textContent).toContain('/data/runtime/envs/default-python-3.12/bin/python')
    expect(document.querySelectorAll('[data-testid="runtime-package-row"]').length).toBe(2)
    // Conda-style listing: Build/Channel columns + the conda/pypi summary.
    expect(dialog?.textContent).toContain('Build')
    expect(dialog?.textContent).toContain('Channel')
    expect(dialog?.textContent).toContain('py312hb2f4e1b_0')
    expect(dialog?.textContent).toContain('2 of 2 · 2 conda, 0 pypi')

    const filter = document.querySelector<HTMLInputElement>(
      '[data-testid="runtime-packages-filter"]'
    )
    expect(filter).not.toBeNull()
    await act(async () => setInputValue(filter!, 'nump'))
    expect(document.querySelectorAll('[data-testid="runtime-package-row"]').length).toBe(1)
    expect(dialog?.textContent).toContain('1 of 2 · 2 conda, 0 pypi')
  })

  it('shows name/version only (no conda columns or summary) for pip-style listings', async () => {
    await render()
    await flush()
    const button = cardWith('System Python')?.querySelector(
      '[data-testid="runtime-packages-button"]'
    )
    await click(button ?? null)

    const dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(document.querySelectorAll('[data-testid="runtime-package-row"]').length).toBe(1)
    expect(dialog?.textContent).toContain('requests')
    expect(dialog?.textContent).not.toContain('Build')
    expect(dialog?.textContent).toContain('1 of 1')
    expect(dialog?.textContent).not.toContain('conda')
  })

  it('shows an error with retry when the dialog fetch fails, and recovers on retry', async () => {
    await render()
    await flush()
    listPackages.mockRejectedValueOnce(new Error('micromamba list failed'))
    const button = cardWith('Python 3.12 (managed)')?.querySelector(
      '[data-testid="runtime-packages-button"]'
    )
    await click(button ?? null)

    const dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(dialog?.textContent).toContain('micromamba list failed')
    const retry = Array.from(document.querySelectorAll('button')).find((b) =>
      /^retry$/i.test((b.textContent ?? '').trim())
    )
    await click(retry ?? null)
    await flush()
    expect(document.querySelectorAll('[data-testid="runtime-package-row"]').length).toBe(2)
  })

  it('shows the conda env name badge for app-owned conda envs, without duplicating it for user-own', async () => {
    const condaEnvs: DiscoveredInterpreter[] = [
      {
        language: 'python',
        provenance: 'app-managed',
        envId: '/data/runtime/envs/default-python/bin/python',
        interpreterPath: '/data/runtime/envs/default-python/bin/python',
        label: 'Python 3.12 (managed)',
        version: '3.12.4',
        runnable: true,
        condaEnv: 'default-python'
      },
      {
        language: 'python',
        provenance: 'user-own',
        envId: '/opt/conda/envs/bio/bin/python',
        interpreterPath: '/opt/conda/envs/bio/bin/python',
        label: 'conda: bio',
        version: '3.11.2',
        runnable: true,
        condaEnv: 'bio'
      }
    ]
    listEnvironments.mockResolvedValue({ python: condaEnvs, r: [] })
    await render()
    await flush()

    const occurrences = (dialog: Element | null, text: string): number =>
      (dialog?.textContent ?? '').split(text).length - 1

    // App-owned conda env: provenance badge is "App-managed", so the conda name gets its own badge.
    await click(
      cardWith('Python 3.12 (managed)')?.querySelector('[data-testid="runtime-packages-button"]') ??
        null
    )
    let dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(dialog?.textContent).toContain('App-managed')
    expect(occurrences(dialog, 'Conda: default-python')).toBe(1)

    // Close, then the user-own conda env: providerType() already yields "Conda: bio" as the
    // provenance badge — the name must appear exactly once (no duplicate second badge).
    const closeBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      /^close$/i.test((b.textContent ?? '').trim())
    )
    await click(closeBtn ?? null)
    await click(
      cardWith('conda: bio')?.querySelector('[data-testid="runtime-packages-button"]') ?? null
    )
    dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(occurrences(dialog, 'Conda: bio')).toBe(1)
  })

  it("installs into the dialog's OWN environment and refreshes the inventory it showed", async () => {
    await render()
    await flush()
    await click(
      cardWith('Python 3.12 (managed)')?.querySelector('[data-testid="runtime-packages-button"]') ??
        null
    )
    const spec = document.querySelector<HTMLInputElement>('[data-testid="runtime-package-spec"]')
    expect(spec).not.toBeNull()
    await act(async () => setInputValue(spec!, 'scipy'))

    const before = listPackages.mock.calls.length
    await click(document.querySelector('[data-testid="runtime-package-install"]'))
    await flush()

    // The request carries the environment the dialog belongs to — NOT the default one — because the
    // main process resolves the target by discovery and must never install into a different
    // environment than the one whose packages the user is looking at.
    expect(managePackages).toHaveBeenCalledWith({
      language: 'python',
      envId: '/data/runtime/envs/default-python-3.12/bin/python',
      packages: ['scipy'],
      operation: 'install'
    })
    // The dialog re-reads the inventory: it must show what the environment NOW holds.
    expect(listPackages.mock.calls.length).toBe(before + 1)
    const notice = document.querySelector('[data-testid="runtime-package-notice"]')
    expect(notice?.textContent).toContain('scipy')
    expect(document.querySelector('[data-testid="runtime-package-error"]')).toBeNull()
  })

  it("removes one package by name and shows the gate's refusal verbatim when it says no", async () => {
    managePackages.mockResolvedValue({
      ok: false,
      needsRestart: false,
      log: '',
      error:
        'Installing packages into your own python environment is not authorized. Turn on "Allow package install" for this environment first.'
    })
    await render()
    await flush()
    await click(
      cardWith('Python 3.12 (managed)')?.querySelector('[data-testid="runtime-packages-button"]') ??
        null
    )
    const before = listPackages.mock.calls.length
    await click(document.querySelectorAll('[data-testid="runtime-package-uninstall"]')[0])
    await flush()

    expect(managePackages).toHaveBeenCalledWith({
      language: 'python',
      envId: '/data/runtime/envs/default-python-3.12/bin/python',
      packages: ['numpy'],
      operation: 'uninstall'
    })
    // Never reworded into something friendlier: the gate's own reason is the reading, and a refused
    // click changes nothing, so the inventory is NOT re-read and no success notice appears.
    const error = document.querySelector('[data-testid="runtime-package-error"]')
    expect(error?.textContent).toContain('is not authorized')
    expect(document.querySelector('[data-testid="runtime-package-notice"]')).toBeNull()
    expect(listPackages.mock.calls.length).toBe(before)
  })
})

describe('RuntimesPanel network-protection status card', () => {
  // Stubs the egress master switch the card mirrors (same window.api.settings.getEgress source as
  // Settings → Network). The module beforeEach window.api stub has no `settings` namespace, so the
  // card stays hidden unless a test adds one.
  const mountWithEgress = async (enabled: boolean, onOpenNetwork?: () => void): Promise<void> => {
    const getEgress = vi.fn().mockResolvedValue({ enabled, groups: {}, customDomains: [] })
    const api = (
      window as unknown as { api: { settings?: { getEgress: ReturnType<typeof vi.fn> } } }
    ).api
    api.settings = { getEgress }
    await act(async () => {
      root.render(
        <RuntimesPanel
          title="Notebook runtimes"
          description="Enable the environments each notebook language may run in."
          onOpenNetwork={onOpenNetwork}
        />
      )
    })
    await act(async () => {})
    await act(async () => {})
    await act(async () => {})
  }

  it('renders the active state when the egress master switch is on', async () => {
    await mountWithEgress(true)

    const card = container.querySelector('[data-testid="runtimes-egress-card"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Notebook network protection is on')
    // Active state needs no affordance to change anything.
    expect(card?.querySelector('button')).toBeNull()
  })

  it('renders the off state and jumps to Network settings when navigation is available', async () => {
    const onOpenNetwork = vi.fn()
    await mountWithEgress(false, onOpenNetwork)

    const card = container.querySelector('[data-testid="runtimes-egress-card"]')
    expect(card?.textContent).toContain('Network protection is off')
    const openButton = card?.querySelector<HTMLButtonElement>(
      '[data-testid="runtimes-egress-open-network"]'
    )
    expect(openButton?.textContent).toContain('Open Network settings')
    await click(openButton ?? null)
    expect(onOpenNetwork).toHaveBeenCalledTimes(1)
  })

  it('omits the Network-settings action when no navigation callback is provided', async () => {
    await mountWithEgress(false)

    const card = container.querySelector('[data-testid="runtimes-egress-card"]')
    expect(card?.textContent).toContain('Network protection is off')
    expect(card?.querySelector('button')).toBeNull()
  })

  it('marks the persisted selection as the current runtime', async () => {
    window.api.runtime.survey = vi.fn().mockResolvedValue([
      {
        language: 'python',
        selection: { source: 'external', interpreterPath: '/usr/bin/python3' },
        managed: {
          language: 'python',
          source: 'managed',
          detected: true,
          selected: false,
          runnable: true,
          packageMutable: true
        },
        external: {
          language: 'python',
          source: 'external',
          detected: true,
          selected: true,
          runnable: true,
          packageMutable: false,
          interpreterPath: '/usr/bin/python3'
        }
      }
    ])
    await render()

    const pythonCards = container.querySelectorAll('[data-testid="runtime-card"]')
    const userOwn = Array.from(pythonCards).find((card) =>
      card.textContent?.includes('/usr/bin/python3')
    )
    // The selected interpreter is named as current, and the app-managed env keeps its own affordance
    // instead of both reading as "current".
    expect(userOwn?.querySelector('[data-testid="runtime-current"]')).not.toBeNull()
    const managed = Array.from(pythonCards).find((card) =>
      card.textContent?.includes('default-python-3.12')
    )
    expect(managed?.querySelector('[data-testid="runtime-current"]')).toBeNull()
    expect(managed?.querySelector('[data-testid="runtime-use-for-notebooks"]')).not.toBeNull()
  })

  it('selects a registered interpreter as the notebook runtime with the flags the backend expects', async () => {
    const setSelection = vi.fn().mockResolvedValue({
      language: 'python',
      selection: { source: 'external', interpreterPath: '/usr/bin/python3' },
      managed: {
        language: 'python',
        source: 'managed',
        detected: true,
        selected: false,
        runnable: true,
        packageMutable: true
      },
      external: {
        language: 'python',
        source: 'external',
        detected: true,
        selected: true,
        runnable: true,
        packageMutable: false,
        interpreterPath: '/usr/bin/python3'
      }
    })
    window.api.runtime.setSelection = setSelection
    await render()

    const userOwn = Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find(
      (card) => card.textContent?.includes('/usr/bin/python3')
    )
    // A user's own interpreter defaults to disabled, and only an enabled runtime may be promoted —
    // the agent never sees a disabled one — so the toggle comes first, as it does for a real user.
    await click(userOwn?.querySelector('[aria-label="Enable System Python"]') ?? null)
    const enabled = Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find(
      (card) => card.textContent?.includes('/usr/bin/python3')
    )
    await click(enabled?.querySelector('[data-testid="runtime-use-for-notebooks"]') ?? null)

    expect(setSelection).toHaveBeenCalledWith('python', {
      source: 'external',
      interpreterPath: '/usr/bin/python3',
      appOwnedOverlay: false,
      packageInstallAuthorized: false
    })
    // The returned survey is applied, so the card now reads as current without a refetch.
    const refreshed = Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find(
      (card) => card.textContent?.includes('/usr/bin/python3')
    )
    expect(refreshed?.querySelector('[data-testid="runtime-current"]')).not.toBeNull()
  })

  it('offers unregister only for an interpreter the system scan cannot find again', async () => {
    const catalogPython: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'user-own',
      registration: 'catalog',
      envId: '/opt/conda/envs/bio/bin/python',
      interpreterPath: '/opt/conda/envs/bio/bin/python',
      label: 'conda: bio',
      version: '3.11.9',
      runnable: true,
      condaEnv: 'bio'
    }
    const unregisterInterpreter = vi.fn().mockResolvedValue([])
    window.api.runtime.unregisterInterpreter = unregisterInterpreter
    listEnvironments
      .mockResolvedValueOnce({ python: [...pythonEnvs, catalogPython], r: rEnvs })
      .mockResolvedValueOnce({ python: pythonEnvs, r: rEnvs })
    await render()

    // A path the system scan finds on its own survives unregistering, so no control is offered that
    // would silently do nothing.
    const systemOwn = Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find(
      (card) => card.textContent?.includes('/usr/bin/python3')
    )
    expect(systemOwn?.querySelector('[data-testid="runtime-unregister"]')).toBeNull()

    const catalogCard = Array.from(container.querySelectorAll('[data-testid="runtime-card"]')).find(
      (card) => card.textContent?.includes('/opt/conda/envs/bio/bin/python')
    )
    await click(catalogCard?.querySelector('[data-testid="runtime-unregister"]') ?? null)

    expect(unregisterInterpreter).toHaveBeenCalledWith('python', '/opt/conda/envs/bio/bin/python')
    const after = Array.from(container.querySelectorAll('[data-testid="runtime-card"]'))
    expect(after.some((card) => card.textContent?.includes('/opt/conda/envs/bio/bin/python'))).toBe(
      false
    )
  })

  it('keeps the card hidden when window.api.settings is not exposed (guard)', async () => {
    // beforeEach leaves window.api without `settings` — existing suites mount the panel that way
    // and must keep rendering unchanged (no card, no extra fetch).
    await render()

    expect(container.querySelector('[data-testid="runtimes-egress-card"]')).toBeNull()
  })
})

describe('RuntimesPanel lock import (A7)', () => {
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    // React's onChange reads value via the synthetic event; the native setter bypasses its tracking.
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const flush = async (): Promise<void> => {
    await act(async () => {})
    await act(async () => {})
  }

  const fillForm = async (name: string, lock: string): Promise<void> => {
    // Radix renders Dialog.Content in a portal on document.body, so dialog internals are queried on
    // `document`, not on the panel container (same convention as the packages dialog tests).
    const nameInput = document.querySelector<HTMLInputElement>(
      '[data-testid="runtime-import-name"]'
    )
    const lockField = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="runtime-import-lock"]'
    )
    expect(nameInput).not.toBeNull()
    expect(lockField).not.toBeNull()
    await act(async () => {
      if (nameInput) setValue(nameInput, name)
      if (lockField) setValue(lockField, lock)
    })
    await flush()
  }

  const lockText =
    'https://conda.example.org/conda-forge/zlib-1.3.1-h1.tar.bz2#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  it('imports through the window bridge and reports the coverage of the created environment', async () => {
    await render()

    // The entry point lives in the language section's action row, next to Add interpreter.
    const open = container.querySelector('[data-testid="runtime-import-lock-python"]')
    expect(open?.textContent).toContain('Import from lock')
    await click(open)
    expect(document.querySelector('[data-testid="runtime-import-dialog"]')).not.toBeNull()

    await fillForm('lock-env', lockText)
    await click(document.querySelector('[data-testid="runtime-import-submit"]'))
    await flush()

    expect(importLock).toHaveBeenCalledWith({
      language: 'python',
      name: 'lock-env',
      lock: lockText,
      allowDownload: true
    })
    const status = document.querySelector('[data-testid="runtime-import-status"]')
    expect(status?.textContent).toContain('lock-env')
    expect(status?.textContent).toContain('2')
    // A successful import refreshes the cards rather than leaving a stale list behind.
    expect(listEnvironments.mock.calls.length).toBeGreaterThan(1)
  })

  it('keeps the submit disabled until both the name and the lock are present', async () => {
    await render()
    await click(container.querySelector('[data-testid="runtime-import-lock-python"]'))

    const submit = (): HTMLButtonElement | null =>
      document.querySelector('[data-testid="runtime-import-submit"]')
    expect(submit()?.disabled).toBe(true)

    await fillForm('lock-env', '')
    expect(submit()?.disabled).toBe(true)

    await fillForm('', lockText)
    expect(submit()?.disabled).toBe(true)

    await fillForm('lock-env', lockText)
    expect(submit()?.disabled).toBe(false)
  })

  it('renders every named reason when nothing was created, and no environment is implied', async () => {
    importLock.mockResolvedValue({
      status: 'incomplete',
      coverage: {
        total: 3,
        fromCache: 1,
        downloaded: 0,
        missing: [
          { file: 'pkg-b.tar.bz2', reason: 'Not in the local cache and downloads are disabled' },
          { file: 'pkg-c.tar.bz2', reason: 'md5 mismatch (expected aaa, got bbb) — discarded' }
        ]
      }
    })
    await render()

    await click(container.querySelector('[data-testid="runtime-import-lock-python"]'))
    await fillForm('lock-env', lockText)
    await click(document.querySelector('[data-testid="runtime-import-submit"]'))
    await flush()

    const status = document.querySelector('[data-testid="runtime-import-status"]')
    expect(status?.textContent).toContain('2')
    expect(status?.textContent).toContain('3')
    const entries = Array.from(
      document.querySelectorAll('[data-testid="runtime-import-missing-entry"]')
    )
    expect(entries).toHaveLength(2)
    expect(entries[0].textContent).toContain('pkg-b.tar.bz2')
    expect(entries[0].textContent).toContain('Not in the local cache')
    expect(entries[1].textContent).toContain('pkg-c.tar.bz2')
    expect(entries[1].textContent).toContain('md5 mismatch')
    // Nothing was created, so the card list must not have been refreshed with a phantom env.
    expect(listEnvironments.mock.calls.length).toBe(1)
  })

  it('shows a named failure when the import request itself rejects', async () => {
    importLock.mockRejectedValue(new Error('Environment management is unavailable.'))
    await render()

    await click(container.querySelector('[data-testid="runtime-import-lock-python"]'))
    await fillForm('lock-env', lockText)
    await click(document.querySelector('[data-testid="runtime-import-submit"]'))
    await flush()

    const error = document.querySelector('[data-testid="runtime-import-error"]')
    expect(error?.textContent).toContain('Environment management is unavailable.')
  })
})

describe('RuntimesPanel named environments (audit P0-8)', () => {
  const flush = async (): Promise<void> => {
    await act(async () => {})
    await act(async () => {})
  }

  const namedEnv = {
    name: 'lock-import-env',
    language: 'python' as const,
    ready: true,
    isDefault: false,
    sizeBytes: 1024,
    interpreterPath: '/data/runtime/envs/lock-import-env/bin/python'
  }

  it('lists a named environment, removes it after confirmation, and reports the removal', async () => {
    manageNamedEnvironments.mockImplementation(async (request: { action: string }) =>
      request.action === 'list' ? { environments: [namedEnv] } : { environments: [] }
    )
    await render()

    const row = container.querySelector('[data-testid="named-env-row"]')
    expect(row?.textContent).toContain('lock-import-env')
    expect(row?.textContent).toContain(namedEnv.interpreterPath)

    // Removal is confirmed first — it deletes files and cannot be undone.
    await click(row?.querySelector('[data-testid="named-env-remove"]') ?? null)
    expect(document.querySelector('[data-testid="named-env-remove-dialog"]')).not.toBeNull()
    await click(document.querySelector('[data-testid="named-env-remove-confirm"]'))
    await flush()

    expect(manageNamedEnvironments).toHaveBeenCalledWith({
      action: 'remove',
      name: 'lock-import-env'
    })
    const notice = container.querySelector('[data-testid="runtimes-notice"]')
    expect(notice?.textContent).toContain('lock-import-env')
    // The list reflects the refreshed set the service returned (empty here).
    expect(container.querySelector('[data-testid="named-env-row"]')).toBeNull()
  })

  it("shows the service's refusal verbatim when a live kernel holds the environment", async () => {
    manageNamedEnvironments.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'remove') {
        throw new Error(
          'Environment "lock-import-env" is in use by a running kernel — restart the notebook or wait for the run to finish before removing it.'
        )
      }
      return { environments: [namedEnv] }
    })
    await render()

    await click(
      container.querySelector('[data-testid="named-env-row"] [data-testid="named-env-remove"]')
    )
    await click(document.querySelector('[data-testid="named-env-remove-confirm"]'))
    await flush()

    // Never reworded into something friendlier: the refusal itself is the reading.
    const error = container.querySelector('[data-testid="runtimes-error"]')
    expect(error?.textContent).toContain('is in use by a running kernel')
    // The row survives — nothing was deleted.
    expect(container.querySelector('[data-testid="named-env-row"]')).not.toBeNull()
  })

  it('opens the Packages dialog for a named environment, addressed by its own interpreter', async () => {
    manageNamedEnvironments.mockImplementation(async (request: { action: string }) =>
      request.action === 'list' ? { environments: [namedEnv] } : { environments: [] }
    )
    await render()
    await flush()
    const button = container.querySelector(
      '[data-testid="named-env-row"] [data-testid="named-env-packages"]'
    )
    expect(button, 'the named row must offer the Packages action').not.toBeNull()
    await click(button)
    await flush()
    const dialog = document.querySelector('[data-testid="runtime-packages-dialog"]')
    expect(dialog).not.toBeNull()
    // A named environment is not a discovery entry, so the identity has to come from the row itself —
    // and it is the only place the app's rules allow a removal (the default env is additive-only).
    expect(listPackages).toHaveBeenCalledWith(
      'python',
      '/data/runtime/envs/lock-import-env/bin/python'
    )
  })
})
