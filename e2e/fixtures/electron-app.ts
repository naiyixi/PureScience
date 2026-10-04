import { test as base } from '@playwright/test'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { terminateProcessTree } from '../../src/main/process-tree'
import { RendererFailureGate } from './renderer-failure-gate'

const APP_ROOT = resolve(process.cwd())
const FAKE_AGENT_PATH = resolve(APP_ROOT, 'e2e', 'fixtures', 'fake-opencode.mjs')
const FAKE_REMOTEIT_PATH = resolve(APP_ROOT, 'e2e', 'fixtures', 'fake-remoteit.cjs')
const FAKE_PROVIDER_NAME = 'Electron E2E provider'

const electronLaunchTarget = (
  userDataRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): { args: string[]; executablePath?: string } => {
  const executablePath = environment.PURESCIENCE_E2E_EXECUTABLE
  return {
    args: [
      // Force English so selectors stay deterministic regardless of the host OS locale
      // (the app's "follow system" language default would otherwise localize the UI on
      // zh-CN developers' machines and every non-English CI runner).
      '--lang=en-US',
      `--user-data-dir=${userDataRoot}`,
      ...(platform === 'linux' ? ['--password-store=basic'] : []),
      ...(executablePath ? [] : [APP_ROOT])
    ],
    ...(executablePath ? { executablePath } : {})
  }
}

type LaunchRoots = {
  fakeAgentBinRoot: string
  fakeRemoteItRoot: string
  fakeRemoteItState: string
  storageRoot: string
  userDataRoot: string
}

type ShortcutModifier = 'alt' | 'control' | 'meta' | 'shift'

type ElectronCleanupTarget = {
  close: () => Promise<void>
  forceClose: () => Promise<void>
}

type ElectronCleanupOptions = {
  forcedTimeoutMs: number
  gracefulTimeoutMs: number
}

const settlesWithin = async (promise: Promise<void>, timeoutMs: number): Promise<boolean> =>
  new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    promise.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

const closeElectronApplicationForCleanup = async (
  target: ElectronCleanupTarget,
  { gracefulTimeoutMs, forcedTimeoutMs }: ElectronCleanupOptions
): Promise<void> => {
  const forceCloseWithinBudget = async (): Promise<void> => {
    if (await settlesWithin(target.forceClose(), forcedTimeoutMs)) return
    throw new Error(`Electron E2E forced close did not finish within ${forcedTimeoutMs}ms.`)
  }

  let closeError: unknown
  const closing = target.close().catch((error: unknown) => {
    closeError = error
  })
  if (await settlesWithin(closing, gracefulTimeoutMs)) {
    if (closeError === undefined) return
    await forceCloseWithinBudget()
    throw closeError
  }

  await forceCloseWithinBudget()
  if (closeError !== undefined) throw closeError
}

type ElectronApp = {
  readonly page: Page
  /**
   * The storage root the launched app was given. A spec that has to hash a MANAGED file on disk (the
   * annotation export's byte-level assertion is exactly that) reads it here rather than guessing at a
   * container path.
   */
  readonly storageRoot: string
  completeOnboarding: () => Promise<Page>
  configureFakeAgent: () => Promise<Page>
  createTestDirectory: (name: string) => Promise<string>
  enableFakeRemoteIt: () => Promise<Page>
  findOverlayIsVisible: () => Promise<boolean>
  launchSecondInstance: () => Promise<Page>
  mainWindowState: () => Promise<{ minimized: boolean; visible: boolean }>
  /**
   * Resizes the main window. The pane widths every preview is laid out from follow the window, and no
   * renderer surface can resize its own window, so a spec that has to reproduce a narrow preview pane
   * (the app's own minimum width is 1100) asks the window directly. Sizes below the window's minimum are
   * clamped by the OS, which is the point: the requested size is what a reader can actually reach.
   *
   * `belowMinimum` lowers the window's own minimum first, so a spec can lay the window out narrower than
   * any size a reader can drag it to — a size the app itself never produces — and prove its geometry is
   * read back from the pane instead of assumed from the window this machine happens to give. Every size a
   * reader can reach is at or above the app's minimum.
   */
  setMainWindowSize: (
    size: { width: number; height: number },
    options?: { belowMinimum?: boolean }
  ) => Promise<void>
  pressMainWindowShortcut: (key: string, modifiers: ShortcutModifier[]) => Promise<void>
  /** Reads the OS clipboard from the main process: the window denies Chromium clipboard access. */
  readClipboardText: () => Promise<string>
  /**
   * Replaces the native save dialog in the main process. No test can operate a native dialog, so this is the
   * one seam a save-to-file flow needs; everything downstream (IPC, the work itself, the write) stays real.
   * Pass null to simulate the user cancelling.
   */
  stubSaveDialog: (filePath: string | null) => Promise<void>
  /**
   * The options the stubbed dialog was last handed — `defaultPath` is the file name the APP itself asked
   * for, which the stub would otherwise swallow.
   */
  lastSaveDialogOptions: () => Promise<{ defaultPath?: string } | null>
  /**
   * Serves a release manifest for the app's own `version.json` request. The update check runs in the MAIN
   * process through Electron's `net.fetch`, so no page-level route can intercept it; replacing that one
   * call is the smallest seam that keeps everything downstream real (real UpdateService, real status
   * broadcast, real update store, real dialog). Every other request is passed through untouched.
   */
  stubUpdateManifest: (manifest: unknown) => Promise<void>
  requestMainWindowClose: () => Promise<void>
  /**
   * Quits the app the way its own tray/menu Quit does (`app.quit()`). Deliberately NOT
   * `requestMainWindowClose`: on macOS a window close classifies as 'hide' (minimize to tray) — see
   * windows.ts — so it never reaches the quit path a spec asserting quit behavior needs.
   */
  requestQuit: () => Promise<void>
  restart: () => Promise<Page>
}

const launchEnvironment = (
  storageRoot: string,
  fakeAgentBinRoot?: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  fakeRemoteItRoot?: string
): Record<string, string> => {
  const environment: Record<string, string> = {}

  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') environment[key] = value
  }

  environment.PURESCIENCE_STORAGE_ROOT = storageRoot
  // The data root is derived from the E2E root, not from the config root: without this a development run
  // derives its data root from HOME, so a certification spec reads and writes the developer's real
  // ~/PureScience-DEV and can fail on one machine while passing on CI. Set it for every run.
  environment.PURESCIENCE_E2E_STORAGE_ROOT = storageRoot
  if (fakeRemoteItRoot) {
    environment.PURESCIENCE_FAKE_REMOTEIT_STATE = join(storageRoot, 'fake-remoteit-state.json')
    environment.PURESCIENCE_REMOTEIT_BIN = process.execPath
  }
  if (fakeAgentBinRoot) {
    const inheritedPath = Object.entries(environment).find(
      ([key]) => key.toLowerCase() === 'path'
    )?.[1]
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === 'path') delete environment[key]
    }
    environment.PURESCIENCE_AGENT_FRAMEWORK = 'opencode'
    environment.PATH = `${fakeAgentBinRoot}${delimiter}${inheritedPath ?? ''}`
  }
  return environment
}

const launchPureScience = async (
  { storageRoot, userDataRoot, fakeAgentBinRoot }: LaunchRoots,
  fakeAgentEnabled: boolean,
  fakeRemoteItEnabled: boolean,
  fakeRemoteItRoot: string
): Promise<ElectronApplication> => {
  const application = await electron.launch({
    ...electronLaunchTarget(userDataRoot),
    cwd: fakeRemoteItEnabled ? fakeRemoteItRoot : APP_ROOT,
    env: launchEnvironment(
      storageRoot,
      fakeAgentEnabled ? fakeAgentBinRoot : undefined,
      process.env,
      fakeRemoteItEnabled ? fakeRemoteItRoot : undefined
    )
  })

  if (process.platform === 'linux') {
    await application.evaluate(({ safeStorage }) => {
      safeStorage.setUsePlainTextEncryption(true)
    })
  }

  return application
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const writeFakeAgentLauncher = async (binRoot: string): Promise<void> => {
  await mkdir(binRoot, { recursive: true })

  if (process.platform === 'win32') {
    await writeFile(
      join(binRoot, 'opencode.cmd'),
      `@echo off\r\n"${process.execPath}" "${FAKE_AGENT_PATH}" %*\r\n`,
      'utf8'
    )
    return
  }

  const launcher = join(binRoot, 'opencode')
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_AGENT_PATH)} "$@"\n`,
    'utf8'
  )
  await chmod(launcher, 0o755)
}

const writeFakeRemoteItCommands = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true })
  const source = `require(${JSON.stringify(FAKE_REMOTEIT_PATH)})\n`
  await Promise.all(
    ['exec-gql', 'service', 'status', 'version'].map((command) =>
      writeFile(join(root, command), source, 'utf8')
    )
  )
}

const makeTreeWritable = async (root: string): Promise<void> => {
  await chmod(root, 0o700).catch(() => undefined)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) await makeTreeWritable(path)
      else if (!entry.isSymbolicLink()) await chmod(path, 0o600).catch(() => undefined)
    })
  )
}

const openMainWindow = async (
  application: ElectronApplication,
  rendererFailures: RendererFailureGate
): Promise<Page> => {
  const page = await application.firstWindow()
  await rendererFailures.observe(page)
  await page.waitForLoadState('domcontentloaded')
  return page
}

class ElectronAppHarness implements ElectronApp {
  private application: ElectronApplication | undefined
  private currentPage: Page | undefined
  private fakeAgentEnabled = false
  private fakeRemoteItEnabled = false
  private readonly rendererFailures = new RendererFailureGate()

  private constructor(
    private readonly testRoot: string,
    private readonly roots: LaunchRoots
  ) {}

  static async create(): Promise<ElectronAppHarness> {
    const testRoot = await mkdtemp(join(tmpdir(), 'purescience-electron-e2e-'))
    const harness = new ElectronAppHarness(testRoot, {
      fakeAgentBinRoot: join(testRoot, 'fake-agent-bin'),
      fakeRemoteItRoot: join(testRoot, 'fake-remoteit'),
      fakeRemoteItState: join(testRoot, 'storage', 'fake-remoteit-state.json'),
      storageRoot: join(testRoot, 'storage'),
      userDataRoot: join(testRoot, 'electron-profile')
    })
    try {
      await mkdir(harness.roots.storageRoot, { recursive: true })
      await writeFile(harness.roots.fakeRemoteItState, JSON.stringify({ services: [] }), 'utf8')
      await writeFakeAgentLauncher(harness.roots.fakeAgentBinRoot)
      await writeFakeRemoteItCommands(harness.roots.fakeRemoteItRoot)
      await harness.launch()
      return harness
    } catch (error) {
      await harness.dispose().catch(() => undefined)
      throw error
    }
  }

  get page(): Page {
    if (!this.currentPage) throw new Error('Electron application is not running.')
    return this.currentPage
  }

  get storageRoot(): string {
    return this.roots.storageRoot
  }

  async completeOnboarding(): Promise<Page> {
    await this.page.evaluate(async () => {
      const bridge = globalThis as unknown as {
        api: { settings: { markOnboardingComplete: () => Promise<unknown> } }
      }
      await bridge.api.settings.markOnboardingComplete()
    })
    await this.page.reload({ waitUntil: 'domcontentloaded' })
    return this.page
  }

  async configureFakeAgent(): Promise<Page> {
    await this.page.evaluate(async (providerName) => {
      const bridge = globalThis as unknown as {
        api: {
          settings: {
            setActiveProvider: (request: { id: string; model: string }) => Promise<unknown>
            setAgentFramework: (request: { id: 'opencode' }) => Promise<unknown>
            upsertProvider: (request: {
              apiEndpoints: ['openai']
              baseUrl: string
              key: string
              model: string
              name: string
              type: 'custom'
            }) => Promise<{ providers: Array<{ id: string; name: string }> }>
          }
        }
      }
      const snapshot = await bridge.api.settings.upsertProvider({
        type: 'custom',
        name: providerName,
        apiEndpoints: ['openai'],
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'e2e-model',
        key: 'e2e-key'
      })
      const provider = snapshot.providers.find((item) => item.name === providerName)
      if (!provider) throw new Error('The E2E provider was not persisted.')

      await bridge.api.settings.setActiveProvider({ id: provider.id, model: 'e2e-model' })
      await bridge.api.settings.setAgentFramework({ id: 'opencode' })
    }, FAKE_PROVIDER_NAME)

    this.fakeAgentEnabled = true
    return this.restart()
  }

  async createTestDirectory(name: string): Promise<string> {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid E2E directory name: ${name}`)
    const path = join(this.testRoot, name)
    await mkdir(path, { recursive: true })
    return path
  }

  async enableFakeRemoteIt(): Promise<Page> {
    this.fakeRemoteItEnabled = true
    return this.restart()
  }

  async findOverlayIsVisible(): Promise<boolean> {
    return this.runningApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) return false

      return mainWindow.contentView.children.some((view) => {
        const bounds = view.getBounds()
        return bounds.width > 0 && bounds.height > 0
      })
    })
  }

  async mainWindowState(): Promise<{ minimized: boolean; visible: boolean }> {
    return this.runningApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('PureScience main window was not found.')

      return { minimized: mainWindow.isMinimized(), visible: mainWindow.isVisible() }
    })
  }

  async setMainWindowSize(
    size: { width: number; height: number },
    options: { belowMinimum?: boolean } = {}
  ): Promise<void> {
    await this.runningApplication.evaluate(
      ({ BrowserWindow }, next) => {
        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (!mainWindow) throw new Error('PureScience main window was not found.')

        // A window narrower than the app's own minimum is a size no reader can reach; it is only ever
        // asked for to prove a spec reads the layout back instead of assuming one, so the minimum is
        // lowered for the lifetime of this window (disposed with the app) and nothing else changes.
        if (next.belowMinimum) mainWindow.setMinimumSize(0, 0)

        // Read the width back before anything measures the layout: a width below the window's own minimum
        // is clamped by the OS, and a spec that laid out a size it did not get would assert on nothing.
        // The height is the display's to clamp (a taller request is cut to the work area), and no pane
        // width depends on it.
        mainWindow.setSize(next.width, next.height)
        const [width] = mainWindow.getSize()
        if (width !== next.width) {
          throw new Error(
            `The main window is ${width}px wide instead of the requested ${next.width}px.`
          )
        }
      },
      { width: size.width, height: size.height, belowMinimum: options.belowMinimum === true }
    )
  }

  async launchSecondInstance(): Promise<Page> {
    const { appPath, executable } = await this.runningApplication.evaluate(({ app }) => ({
      appPath: app.getAppPath(),
      executable: process.execPath
    }))
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      const child = spawn(
        executable,
        [
          `--user-data-dir=${this.roots.userDataRoot}`,
          ...(process.env.PURESCIENCE_E2E_EXECUTABLE ? [] : [appPath])
        ],
        {
          cwd: APP_ROOT,
          env: launchEnvironment(
            this.roots.storageRoot,
            this.fakeAgentEnabled ? this.roots.fakeAgentBinRoot : undefined,
            process.env,
            this.fakeRemoteItEnabled ? this.roots.fakeRemoteItRoot : undefined
          ),
          stdio: 'ignore'
        }
      )
      child.once('error', rejectLaunch)
      child.once('exit', (code, signal) => {
        if (code === 0) resolveLaunch()
        else rejectLaunch(new Error(`Second Electron instance exited with ${code ?? signal}.`))
      })
    })
    return this.page
  }

  async pressMainWindowShortcut(key: string, modifiers: ShortcutModifier[]): Promise<void> {
    await this.runningApplication.evaluate(
      ({ BrowserWindow }, input) => {
        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (!mainWindow) throw new Error('PureScience main window was not found.')

        mainWindow.webContents.focus()
        mainWindow.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: input.key,
          modifiers: input.modifiers
        })
        mainWindow.webContents.sendInputEvent({
          type: 'keyUp',
          keyCode: input.key,
          modifiers: input.modifiers
        })
      },
      { key, modifiers }
    )
  }

  async readClipboardText(): Promise<string> {
    return this.runningApplication.evaluate(({ clipboard }) => clipboard.readText())
  }

  async stubSaveDialog(filePath: string | null): Promise<void> {
    await this.runningApplication.evaluate(({ dialog }, path) => {
      // The two call shapes the app uses (with and without a parent window) both land here, and the
      // options are kept so a test can read the file name the APP proposed (`defaultPath`).
      dialog.showSaveDialog = async (
        windowOrOptions: unknown,
        maybeOptions?: unknown
      ): Promise<{ canceled: boolean; filePath: string }> => {
        const options = (maybeOptions ?? windowOrOptions) as { defaultPath?: string } | undefined
        ;(globalThis as { __psLastSaveDialogOptions?: unknown }).__psLastSaveDialogOptions = options
        return { canceled: path === null, filePath: path ?? '' }
      }
    }, filePath)
  }

  async lastSaveDialogOptions(): Promise<{ defaultPath?: string } | null> {
    return this.runningApplication.evaluate(
      () =>
        (globalThis as { __psLastSaveDialogOptions?: { defaultPath?: string } })
          .__psLastSaveDialogOptions ?? null
    )
  }

  async stubUpdateManifest(manifest: unknown): Promise<void> {
    await this.runningApplication.evaluate(({ net }, payload) => {
      const originalFetch = net.fetch.bind(net)
      const body = JSON.stringify(payload)
      // Read at call time by the app's fetch wrapper, so replacing the property is enough — no module
      // is reloaded and every other request keeps going to the real network stack.
      net.fetch = ((input: unknown, init?: unknown) => {
        const url =
          typeof input === 'string' ? input : String((input as { url?: unknown } | null)?.url ?? '')
        if (url.split('?')[0].endsWith('/version.json')) {
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          )
        }
        return originalFetch(input as never, init as never)
      }) as unknown as typeof net.fetch
    }, manifest)
  }

  async requestMainWindowClose(): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('PureScience main window was not found.')
      mainWindow.close()
    })
  }

  /** Quits the app the way its own tray/menu Quit does. See the interface comment for why not `close()`. */
  async requestQuit(): Promise<void> {
    await this.runningApplication.evaluate(({ app }) => {
      app.quit()
    })
  }

  async restart(): Promise<Page> {
    await this.close()
    await this.launch()
    return this.page
  }

  async dispose(): Promise<void> {
    await this.closeForCleanup().catch(() => undefined)
    await makeTreeWritable(this.testRoot)
    await rm(this.testRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
    this.rendererFailures.assertNoFailures()
  }

  private async launch(): Promise<void> {
    this.application = await launchPureScience(
      this.roots,
      this.fakeAgentEnabled,
      this.fakeRemoteItEnabled,
      this.roots.fakeRemoteItRoot
    )
    this.currentPage = await openMainWindow(this.application, this.rendererFailures)
  }

  private get runningApplication(): ElectronApplication {
    if (!this.application) throw new Error('Electron application is not running.')
    return this.application
  }

  private async close(): Promise<void> {
    if (!this.application) return

    const application = this.application
    this.application = undefined
    this.currentPage = undefined
    // Bounded like the teardown path, and for a measured reason: an unbounded close hangs when a turn is
    // still in flight (284s observed, then the test timed out), because the app holds its shutdown until
    // that turn settles — and the acceptance for an interrupted turn restarts on purpose while one is open.
    // Graceful if the app can manage it, forced otherwise.
    await closeElectronApplicationForCleanup(
      {
        close: () => application.close(),
        forceClose: async () => {
          const result = await terminateProcessTree(application.process())
          if (!result.reaped)
            throw new Error('Electron E2E forced close did not reap the process tree.')
        }
      },
      { gracefulTimeoutMs: 10_000, forcedTimeoutMs: 10_000 }
    )
  }

  private async closeForCleanup(): Promise<void> {
    if (!this.application) return

    const application = this.application
    this.application = undefined
    this.currentPage = undefined
    await closeElectronApplicationForCleanup(
      {
        close: () => application.close(),
        forceClose: async () => {
          const result = await terminateProcessTree(application.process())
          if (!result.reaped)
            throw new Error('Electron E2E forced close did not reap the process tree.')
        }
      },
      { gracefulTimeoutMs: 10_000, forcedTimeoutMs: 10_000 }
    )
  }
}

const test = base.extend<{ app: ElectronApp }>({
  // Playwright fixture callbacks require an object pattern even when no base fixture is needed.
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, install) => {
    const app = await ElectronAppHarness.create()

    try {
      await install(app)
    } finally {
      await app.dispose()
    }
  }
})

export { closeElectronApplicationForCleanup, electronLaunchTarget, launchEnvironment, test }
export type { ElectronApp }
