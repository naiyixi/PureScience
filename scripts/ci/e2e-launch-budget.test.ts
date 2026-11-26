import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MIN_WINDOW_BUDGET_MS,
  WINDOW_BUDGET_MARGIN_MS,
  resolveWindowBudgetMs
} from '../../e2e/fixtures/launch-budget'

/**
 * The first-window wait is a request the runner may not honour.
 *
 * `playwright.config.ts` gives every spec 120 s; the packaged lane asked `firstWindow()` for 180 s. A window
 * that took longer than 120 s therefore died as `Test timeout … while setting up "app"` — no launch log, no
 * process state, and a retry that passed hid the evidence (v2.33.9's P0, references-page-selection). These
 * cases pin the resolved budget: always positive (Playwright reads `timeout: 0` as "no timeout"), never
 * longer than what is left of the test, and unchanged when the lane's own number already fits.
 */
describe('first-window budget', () => {
  it('leaves the dev lane alone: a 30 s request inside a 120 s test stays 30 s', () => {
    expect(resolveWindowBudgetMs({ configuredMs: 30_000, remainingMs: 120_000 })).toBe(30_000)
  })

  it('clamps the packaged request to what the test has left, keeping the margin for the named failure', () => {
    expect(resolveWindowBudgetMs({ configuredMs: 180_000, remainingMs: 120_000 })).toBe(
      120_000 - WINDOW_BUDGET_MARGIN_MS
    )
  })

  it('clamps a restart late in the test to the remaining budget, not the lane default', () => {
    expect(resolveWindowBudgetMs({ configuredMs: 180_000, remainingMs: 20_000 })).toBe(
      20_000 - WINDOW_BUDGET_MARGIN_MS
    )
  })

  it('never returns zero or a negative number, because firstWindow({ timeout: 0 }) waits forever', () => {
    for (const remainingMs of [WINDOW_BUDGET_MARGIN_MS, WINDOW_BUDGET_MARGIN_MS - 1, 0, -5_000]) {
      const budget = resolveWindowBudgetMs({ configuredMs: 180_000, remainingMs })
      expect(budget).toBeGreaterThan(0)
      expect(budget).toBe(MIN_WINDOW_BUDGET_MS)
    }
  })

  it('keeps the configured request when the test has no timeout (or it is unusable)', () => {
    expect(
      resolveWindowBudgetMs({ configuredMs: 180_000, remainingMs: Number.POSITIVE_INFINITY })
    ).toBe(180_000)
    expect(resolveWindowBudgetMs({ configuredMs: Number.NaN, remainingMs: 60_000 })).toBe(
      60_000 - WINDOW_BUDGET_MARGIN_MS
    )
  })

  it('never plans to wait past the smaller of the request and the remaining budget', () => {
    for (const configuredMs of [5_000, 30_000, 180_000, 600_000]) {
      for (const remainingMs of [10_000, 45_000, 120_000, 300_000]) {
        const budget = resolveWindowBudgetMs({ configuredMs, remainingMs })
        expect(budget).toBeLessThanOrEqual(Math.min(configuredMs, remainingMs))
      }
    }
  })
})

/**
 * The resolver above is only worth its cases if the fixture actually uses it: passing the raw configured
 * number to `firstWindow()` would reproduce the defect while every case above stayed green.
 */
describe('the Electron fixture hands the resolved budget to firstWindow', () => {
  const source = readFileSync(resolve('e2e/fixtures/electron-app.ts'), 'utf8')

  it('resolves the budget before waiting on the window', () => {
    expect(source).toContain('resolveWindowBudgetMs({')
    expect(source.indexOf('resolveWindowBudgetMs({')).toBeLessThan(
      source.indexOf('application.firstWindow(')
    )
  })

  it('waits with the resolved number, never with the configured one', () => {
    expect(source).toContain(
      'firstWindow: () => application.firstWindow({ timeout: windowTimeoutMs })'
    )
    expect(source).not.toContain(
      'firstWindow: () => application.firstWindow({ timeout: configuredWindowTimeoutMs })'
    )
  })

  it('derives the remaining budget from the test the fixture belongs to', () => {
    expect(source).toContain('testInfo.timeout - (Date.now() - startedAt)')
    expect(source).toContain('remainingBudgetMs: () =>')
  })
})
