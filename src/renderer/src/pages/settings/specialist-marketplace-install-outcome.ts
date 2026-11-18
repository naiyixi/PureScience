// Where a finished marketplace install should leave the user.
//
// A package installed from the market is written disabled with `setupPending` (see
// specialist/package/transaction.ts — an imported system prompt is never activated silently), so the
// install is not usable yet: the Specialist list only badges the row, and the chat picker lists enabled
// Specialists only. Returning to the list therefore looked like "installed and done" while the thing was
// invisible in every place the user would look for it. The editor is the one screen that both names the
// state and carries the save button that completes it.
export type PostInstallView = { kind: 'list' } | { kind: 'edit'; id: string }

export const postInstallView = (installed: {
  setupPending?: boolean
  specialistId: string
}): PostInstallView =>
  installed.setupPending === true ? { kind: 'edit', id: installed.specialistId } : { kind: 'list' }
