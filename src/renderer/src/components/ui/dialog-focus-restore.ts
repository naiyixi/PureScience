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

export const useDialogFocusRestore = (open: boolean): DialogFocusRestore => {
  const openerRef = useRef<HTMLElement | null>(null)

  const focusOpener = (): void => {
    const opener = openerRef.current
    openerRef.current = null
    if (opener?.isConnected) opener.focus()
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
      openerRef.current = active instanceof HTMLElement ? active : null
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      focusOpener()
    }
  }
}
