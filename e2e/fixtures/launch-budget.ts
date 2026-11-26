/**
 * How long a launch may wait for its first window, given the budget the runner itself will enforce.
 *
 * Why this exists: the packaged certification lane asked `firstWindow()` for 180 s while Playwright's
 * per-test timeout is 120 s (`playwright.config.ts`). A window that took longer than 120 s therefore never
 * reached the named failure — the run reported `Test timeout of 120000ms exceeded while setting up "app"`,
 * which says nothing about the launch, its log, or whether the process was alive. Measured on the v2.33.9
 * release commit (Nightly 45764638376, job 139729574429): `references-page-selection.spec.ts` failed that
 * way on its first attempt and passed on retry, so the retry hid the only evidence the run had.
 *
 * The ceiling that can actually fire is the test's own remaining budget, so that is what this resolves:
 * whatever the caller configured, never plan to wait past `remaining - margin`, leaving the margin for
 * reading the launch log and raising the named failure before Playwright kills the worker.
 */

/** Kept free so the named failure (log tail + process state) is raised before the runner's deadline. */
export const WINDOW_BUDGET_MARGIN_MS = 5_000

/**
 * Last-resort floor. A `firstWindow({ timeout: 0 })` would mean "wait forever" in Playwright, so a budget
 * that has already run out still gets a millisecond-scale wait rather than an unbounded one.
 */
export const MIN_WINDOW_BUDGET_MS = 1_000

export const resolveWindowBudgetMs = (input: {
  /** What the lane asked for (`PURESCIENCE_E2E_WINDOW_TIMEOUT_MS` or the lane default). */
  configuredMs: number
  /** What is left of the test's own timeout; `Infinity` when the test has no timeout. */
  remainingMs: number
}): number => {
  const configured =
    Number.isFinite(input.configuredMs) && input.configuredMs > 0
      ? input.configuredMs
      : Number.POSITIVE_INFINITY
  if (!Number.isFinite(input.remainingMs)) return configured
  const usable = input.remainingMs - WINDOW_BUDGET_MARGIN_MS
  return Math.min(configured, Math.max(MIN_WINDOW_BUDGET_MS, usable))
}
