// @vitest-environment jsdom
//
// Pins the act environment that `test/setup-jsdom-polyfills.ts` declares. It lives here, under
// `src/renderer/src/`, so `tsconfig.web.json` type-checks it — `test/` is outside both tsconfigs.
//
// Why this exists: without `IS_REACT_ACT_ENVIRONMENT`, React's `act()` takes its degraded path and
// logs "The current testing environment is not configured to support act(...)" on EVERY update it
// sees. That is not a harmless warning in a suite this size — measured on a green Verify job it was
// 77,419 lines and 62% of the 12.4MB job log, and on a red one 77,421 of 114,797 lines, which is the
// difference between a log a reader can scan and one they page through blind.
//
// The setup file is the single place that declares it; 86 test files also declare it for themselves.
// Those stay redundant on purpose (removing them touches 86 files for no behaviour change), but the
// declaration itself must not disappear: this test fails if it does, and fails if the warning comes
// back even though the flag is set (that would mean the flag no longer reaches React).
import { act, createElement, type ReactElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

const WARNING = 'not configured to support act'

/** An update-issuing component: the click handler is what makes React evaluate the act environment. */
function Counter(): ReactElement {
  const [count, setCount] = useState(0)
  return createElement('button', { onClick: () => setCount((value) => value + 1) }, String(count))
}

let host: HTMLDivElement | undefined
let root: Root | undefined

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
    root = undefined
  }
  host?.remove()
  host = undefined
})

it('declares the act environment once, and an update inside act() does not warn', () => {
  const reported: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    reported.push(args.map((value) => String(value)).join(' '))
  })

  try {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    act(() => {
      root?.render(createElement(Counter))
    })
    // A second update while act() is active: this is the path that reads the flag.
    act(() => {
      host?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host.textContent).toBe('1')
    expect(reported.filter((line) => line.includes(WARNING))).toEqual([])
    expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(
      true
    )
  } finally {
    spy.mockRestore()
  }
})
