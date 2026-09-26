import { useEffect, useRef } from 'react'

// Radix restores focus on close by focusing its own `Dialog.Trigger`, and only when there is none
// falls back to whatever `document.activeElement` was when the modal mounted. Almost every dialog in
// this app is opened from a button that lives outside the dialog — the open flag is page state — so
// there is no `Trigger` inside the Root and that fallback is the only mechanism. It is easy to lose:
// it does not run when the layer is unmounted rather than closed (the pages here render the dialog
// itself as `null` when the flag is false), and it silently captures the wrong element when focus
// moved on before the modal's effects ran. Focus then lands on `<body>`, dropping a keyboard user at
// the top of the document instead of the control they came from.
//
// Mount this on the dialog's content to make the restore explicit:
//
//   const focusRestore = useDialogFocusRestore(open)
//   <Dialog.Content onOpenAutoFocus={focusRestore.onOpenAutoFocus}
//                   onCloseAutoFocus={focusRestore.onCloseAutoFocus}>
//
// Compose it when the dialog also wants to place focus itself:
//
//   onOpenAutoFocus={(event) => {
//     focusRestore.onOpenAutoFocus()
//     event.preventDefault()
//     inputRef.current?.focus()
//   }}
export type DialogFocusRestore = {
  // Runs before Radix moves focus into the dialog, which is the only moment the opener is still the
  // active element.
  onOpenAutoFocus: () => void
  // Idempotent companion for the paths where Radix does fire its close event: claiming the event
  // stops the (here fruitless) trigger lookup from running after us.
  onCloseAutoFocus: (event: Event) => void
}

// The element that had focus outside any dialog, tracked as focus moves. Reading `document.activeElement`
// only at Radix's open-autofocus event is not enough: a dialog that focuses its own field on mount (React's
// `autoFocus`, or a select) does that during the commit, *before* Radix fires the event — so the reading
// would be the dialog's own input, and "restoring" focus to it is a no-op once it unmounts. Focus that lands
// inside a dialog layer is therefore ignored here, which leaves the control the person actually came from.
let lastFocusOutsideDialogs: HTMLElement | null = null
let isTrackingFocus = false

const trackFocusOutsideDialogs = (): void => {
  if (isTrackingFocus) return
  isTrackingFocus = true
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (target.closest('[role="dialog"]')) return
      lastFocusOutsideDialogs = target
    },
    true
  )
}

// Installed when the module loads (guarded for non-DOM environments) instead of from the first hook: the
// focus that matters — the person clicking or tabbing to the control that opens a dialog — can happen before
// any dialog component has run its effects.
if (typeof document !== 'undefined') trackFocusOutsideDialogs()

export const useDialogFocusRestore = (open: boolean): DialogFocusRestore => {
  const openerRef = useRef<HTMLElement | null>(null)

  const focusOpener = (): void => {
    const opener = openerRef.current
    openerRef.current = null
    if (!opener?.isConnected) return
    opener.focus()
    // Dialogs with an exit animation are still mounted when this runs, and their focus trap pulls
    // focus back inside — the restore is then lost when the layer finally unmounts. Re-assert once
    // the layer is gone, but only if nothing else claimed focus in the meantime.
    window.setTimeout(() => {
      if (document.activeElement === document.body) opener.focus()
    }, 0)
  }

  // The close transition is observed here rather than only through Radix's event, so the restore
  // happens even when the dialog is unmounted wholesale. Effect cleanups run before the removed
  // subtree can leave focus nowhere.
  useEffect(() => {
    if (!open) return undefined
    return () => focusOpener()
  }, [open])

  return {
    onOpenAutoFocus: () => {
      const active = document.activeElement
      // Prefer the element that is focused right now, as long as it is a real control outside every dialog.
      // When it is the dialog's own field (mounted with `autoFocus`, or a select that grabs focus during the
      // commit) or the body, fall back to the last element focused outside a dialog — the control the person
      // actually came from.
      const external =
        active instanceof HTMLElement &&
        active !== document.body &&
        active.closest('[role="dialog"]') === null
      openerRef.current = external ? active : lastFocusOutsideDialogs
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      focusOpener()
    }
  }
}
