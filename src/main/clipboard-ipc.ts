import { clipboard } from 'electron'

import { ipcMainHandle } from './ipc-handler-registry'

// Every Chromium permission is denied by construction (see windows.ts), which also covers the clipboard: a
// renderer calling navigator.clipboard is refused in the packaged app, and the refusal used to be swallowed —
// a copy button that did nothing looked exactly like one that worked. Writing from the main process is not a
// permission at all, so copying goes through here.
const registerClipboardIpcHandlers = (): void => {
  ipcMainHandle('clipboard:write-text', (_event, request: unknown) => {
    const text = (request as { text?: unknown } | undefined)?.text
    if (typeof text !== 'string') {
      throw new Error('clipboard:write-text expects { text }')
    }
    clipboard.writeText(text)
  })
}

export { registerClipboardIpcHandlers }
