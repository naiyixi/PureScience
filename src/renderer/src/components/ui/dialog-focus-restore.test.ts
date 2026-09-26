// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDialogFocusRestore, type DialogFocusRestore } from './dialog-focus-restore'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The hook's whole contract is "whatever had focus when the layer opened gets it back when the layer goes
// away" — including the path where the page unmounts the dialog instead of closing it, which is what every
// no-Trigger dialog in this app does (the open flag is page state, so the dialog renders as null). The
// harness keeps that production shape: one hook call, the layer present only while `open`.
let handlers: DialogFocusRestore | null = null
let container: HTMLDivElement
let root: Root
let opener: HTMLButtonElement
let inside: HTMLButtonElement

const Harness = ({ open }: { open: boolean }): React.JSX.Element => {
  const restore = useDialogFocusRestore(open)
  // Published from an effect, not during render: writing a module-level variable while rendering is a side
  // effect, and this harness exists to exercise the hook, not to bend the rules around it.
  useEffect(() => {
    handlers = restore
  })
  return createElement('div', null, open ? createElement('span', { 'data-testid': 'layer' }) : null)
}

const render = (open: boolean): void => {
  act(() => {
    root.render(createElement(Harness, { open }))
  })
}

const openLayer = (): void => {
  render(true)
  handlers?.onOpenAutoFocus()
  // Radix moves focus into the layer right after the event: stand in for that.
  inside.focus()
}

beforeEach(() => {
  handlers = null
  opener = document.createElement('button')
  inside = document.createElement('button')
  document.body.append(opener, inside)
  opener.focus()
  // jsdom's focus() does not synthesise `focusin`, which is the event the hook tracks the opener with, so
  // the browser's own dispatch is stood in for here. The real path is covered by the packaged-app test
  // (`dialogs opened from page state hand focus back to their opener`).
  opener.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  opener.remove()
  inside.remove()
  container.remove()
})

describe('useDialogFocusRestore', () => {
  it('restores the opener even when the dialog focuses its own field on mount', () => {
    // React's `autoFocus` (and any select that grabs focus) runs during the commit, before Radix fires the
    // open-autofocus event — so by the time the hook is asked to remember the opener, the active element is
    // the dialog's own field. Remembering that field would "restore" focus to a node that is about to
    // unmount, which is how focus ended up on <body>.
    const layer = document.createElement('div')
    layer.setAttribute('role', 'dialog')
    const field = document.createElement('input')
    layer.append(field)
    document.body.append(layer)

    opener.focus()
    opener.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    field.focus()

    render(true)
    handlers?.onOpenAutoFocus()
    expect(document.activeElement).toBe(field)

    render(false)

    expect(document.activeElement).toBe(opener)
    layer.remove()
  })

  it('returns focus to the opener when the layer closes', () => {
    openLayer()
    expect(document.activeElement).toBe(inside)

    render(false)

    expect(document.activeElement).toBe(opener)
  })

  it('returns focus when the page unmounts the dialog instead of closing it', () => {
    openLayer()

    act(() => {
      root.unmount()
    })
    root = createRoot(container)

    expect(document.activeElement).toBe(opener)
  })

  it('claims the close event so Radix does not look for a trigger afterwards', () => {
    openLayer()
    const event = { preventDefault: vi.fn() } as unknown as Event

    handlers?.onCloseAutoFocus(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(opener)
  })

  it('keeps the opener focused once an exit animation has taken focus back', async () => {
    openLayer()

    render(false)
    // A dialog with an exit animation is still mounted when the restore runs; its focus trap pulls focus
    // back inside, and only when the layer finally goes does the layer's own text land on <body>. The hook
    // re-asserts on the next tick for exactly that window.
    inside.focus()
    document.activeElement instanceof HTMLElement && document.activeElement.blur()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.activeElement).toBe(opener)
  })

  it('leaves focus where it is when the opener is no longer in the document', () => {
    openLayer()
    opener.remove()

    expect(() => render(false)).not.toThrow()
    expect(document.activeElement).not.toBe(opener)
  })
})
