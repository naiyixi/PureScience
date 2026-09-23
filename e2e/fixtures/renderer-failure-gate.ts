import type { ConsoleMessage, Page } from 'playwright'

type ObservablePage = Pick<Page, 'consoleMessages' | 'on' | 'pageErrors'>

class RendererFailureGate {
  private readonly failures = new Map<string, Error>()

  async observe(page: ObservablePage): Promise<void> {
    const recordConsole = (message: ConsoleMessage): void => {
      if (message.type() !== 'error') return
      const text = message.text()
      this.failures.set(`console:${text}`, new Error(`[renderer console] ${text}`))
    }
    const recordPageError = (error: Error): void => {
      // The message goes into CI logs where the trace is not downloadable, so it carries the stack:
      // a minified React error number alone cannot be acted on.
      const detail = error.stack ? `${error.message}\n${error.stack}` : error.message
      this.failures.set(
        `pageerror:${error.message}`,
        new Error(`[renderer pageerror] ${detail}`, { cause: error })
      )
    }

    // Attach live listeners first, then backfill Playwright's bounded history so errors emitted while
    // the initial Electron window was navigating cannot escape the gate.
    page.on('console', recordConsole)
    page.on('pageerror', recordPageError)
    const [consoleMessages, pageErrors] = await Promise.all([
      page.consoleMessages(),
      page.pageErrors()
    ])
    consoleMessages.forEach(recordConsole)
    pageErrors.forEach(recordPageError)
  }

  assertNoFailures(): void {
    if (this.failures.size === 0) return
    throw new AggregateError(this.failures.values(), 'Renderer emitted errors during Electron E2E.')
  }
}

export { RendererFailureGate }
