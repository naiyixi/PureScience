import { createContext, useContext } from 'react'

const WorkspaceMessageEditStateContext = createContext(false)

const useWorkspaceMessageEditState = (): boolean => useContext(WorkspaceMessageEditStateContext)

// Mirrors the context value for click-time checks. Reading it inside a handler instead of subscribing keeps
// the row out of the broadcast: edit availability moves a few times per turn, and every move would
// otherwise re-render every user row in the transcript.
let currentCanEditMessage = false

const setWorkspaceMessageCanEdit = (value: boolean): void => {
  currentCanEditMessage = value
}

const readWorkspaceMessageCanEdit = (): boolean => currentCanEditMessage

export {
  WorkspaceMessageEditStateContext,
  useWorkspaceMessageEditState,
  setWorkspaceMessageCanEdit,
  readWorkspaceMessageCanEdit
}
