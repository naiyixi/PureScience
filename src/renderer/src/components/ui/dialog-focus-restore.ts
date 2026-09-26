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

// Both Radix families render their surface with a layer role: `Dialog.Content` is a dialog and
// `AlertDialog.Content` is an alertdialog. Leaving one role out makes the tracker treat the layer's own
// control as "outside" — an AlertDialog focuses its Cancel button on open — and closing would then hand
// focus to something that is itself unmounting.
const DIALOG_LAYER_SELECTOR = '[role="dialog"], [role="alertdialog"]'

// Recent focus targets, newest first. Reading `document.activeElement` only at Radix's open-autofocus event is
// not enough: a dialog that focuses its own field on mount (React's `autoFocus`, or a select) does that during
// the commit, *before* Radix fires the event, so that reading would be the dialog's own input — and
// "restoring" focus to it is a no-op once it unmounts. Deciding at capture time which elements are
// interesting does not work either: the element that opened the dialog may itself sit inside another layer
// (the storage panel's confirm lives in the settings dialog), so "ignore everything inside a dialog" throws
// away the very control we need. Keep a short history instead and pick from it when a layer opens.
const FOCUS_HISTORY_LIMIT = 8
let focusHistory: HTMLElement[] = []
let isTrackingFocus = false

const trackFocus = (): void => {
  if (isTrackingFocus) return
  isTrackingFocus = true
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (focusHistory[0] === target) return
      focusHistory = [target, ...focusHistory].slice(0, FOCUS_HISTORY_LIMIT)
    },
    true
  )
}

// The opener is the most recent still-connected element that is not part of the layer opening right now. That
// layer is the innermost one mounted, and its own autofocus may already have moved focus inside it, so those
// entries are skipped — which leaves the control the person actually came from, whether it sits on the page or
// inside an outer dialog.
const resolveOpener = (): HTMLElement | null => {
  const layers = document.querySelectorAll(DIALOG_LAYER_SELECTOR)
  const opening = layers.length > 0 ? layers[layers.length - 1] : null
  for (const candidate of focusHistory) {
    if (candidate === document.body || !candidate.isConnected) continue
    if (opening && opening.contains(candidate)) continue
    return candidate
  }
  return null
}

// Installed when the module loads (guarded for non-DOM environments) instead of from the first hook: the
// focus that matters — the person clicking or tabbing to the control that opens a dialog — can happen before
// any dialog component has run its effects.
if (typeof document !== 'undefined') trackFocus()

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
      openerRef.current = resolveOpener()
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      focusOpener()
    }
  }
}
