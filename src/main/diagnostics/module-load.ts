// Names the module whose top-level code failed while the application was loading its backend graph.
//
// Real evidence, packaged 2.31.0, 2026-11-19T16:33:54Z and 16:37:00Z: two launches each died 140 ms and
// 161 ms after the `load-application-modules` phase started, and the only record either left was
// `operation failed … phase=load-application-modules errorCategory=error`. That phase awaits one
// `Promise.all` over 24 dynamic imports, so the record could not say WHICH module threw, and the
// message is deliberately not on this surface (diagnostic operations keep a category-only contract —
// pinned by `diagnostics/privacy-canary.test.ts`). An earlier class of the same blind spot, a 60 s
// stall at the same phase, is recorded in `docs/evidence/2026-11-07-macos-x64-smoke-intermittent.md`.
//
// The fix is structural rather than textual: wrap each import so a rejection emits the specifier it was
// loading plus the privacy projection (`describeFailureLocation`: category, class name, basename-only
// frames) before rethrowing the original error. No free text is added, so the category-only contract
// and the privacy canary are unchanged, and the next failure names its module.
//
// Boundaries: this attributes a FAILURE, not a hang. A module whose promise never settles still leaves
// only the phase start behind — naming in-flight imports on a stall needs a watchdog, which is a
// separate unit (the event-loop stall watchdog cannot see an unresolved promise).

import { describeFailureLocation, type FailureLocation } from '../crash-diagnostics'

export type ApplicationModuleFailure = FailureLocation & {
  /** The source-level specifier this process asked for, e.g. `./projects/prisma-client`. */
  module: string
}

export type ApplicationModuleLoader = {
  load: <T>(specifier: string, loadModule: () => Promise<T>) => Promise<T>
}

export type ApplicationModuleLoaderOptions = {
  /** Reports the failed module. Called at most once per failure; never replaces the thrown error. */
  onFailure: (failure: ApplicationModuleFailure) => void
}

export const createApplicationModuleLoader = (
  options: ApplicationModuleLoaderOptions
): ApplicationModuleLoader => ({
  load: async (specifier, loadModule) => {
    try {
      return await loadModule()
    } catch (error) {
      try {
        options.onFailure({
          module: specifier,
          ...describeFailureLocation(error)
        })
      } catch {
        // Diagnostics must never stand in for the failure they describe: a reporter that throws would
        // turn "module X failed" into "the reporter failed", hiding the original cause entirely.
      }
      throw error
    }
  }
})
