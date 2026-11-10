import { useEffect, useState } from 'react'

import type { SessionPackageImportRecord } from '../../../shared/session-package-import'

export type SessionImportPosture = {
  sessionId: string
  record: SessionPackageImportRecord
}

/**
 * The read-only posture an imported session carries, read from the record beside it whenever the
 * session is opened: the session itself says where it came from and that nothing here verified it —
 * not only the dialog that once imported it.
 *
 * Keyed by the two identities that decide WHICH record is read (`projectId`, `sessionId`), never by the
 * session object. The store hands the active session a new object on every committed stream chunk, so
 * an object-keyed effect issued one main-process read per chunk — precisely while the main process is
 * streaming — and each answer set fresh state that re-rendered the whole workspace even though the
 * record on disk had not changed. A record can only appear or disappear together with its session, and
 * importing always creates a new session id, so one read per opened session is the whole contract.
 */
export const useSessionImportPosture = (
  projectId: string | undefined,
  sessionId: string | undefined
): SessionImportPosture | null => {
  const [posture, setPosture] = useState<SessionImportPosture | null>(null)

  useEffect(() => {
    if (!projectId || !sessionId) return
    const readImportPosture = window.api?.sessions?.importPosture
    if (!readImportPosture) return
    let cancelled = false
    void readImportPosture({ projectId, sessionId })
      .then((record) => {
        if (cancelled || !record) return
        setPosture({ sessionId, record })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId])

  // A posture can never linger on a session it does not belong to: the answer is tied to an id, and an
  // ordinary session (no record, nothing to show) simply has none.
  return posture && posture.sessionId === sessionId ? posture : null
}
