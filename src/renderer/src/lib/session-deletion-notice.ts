import type { TranslationKey } from '@/i18n'
import type { SessionNotebookDataDeletion } from '../../../shared/session-persistence'
import { formatBytes } from '../../../shared/update'

// The sentence one session deletion reports. Both surfaces that delete a session (the workspace
// sidebar and the archived list in settings) go through the same channel and must say the same thing,
// so the mapping lives here once rather than as two ternaries that drift the first time either is
// reworded.
type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

export type SessionDeletionNotice = {
  title: string
  notebookData?: SessionNotebookDataDeletion
}

export const sessionDeletionMessage = (
  notice: SessionDeletionNotice,
  lang: string,
  t: Translate
): string => {
  const { title, notebookData } = notice
  // 'removed' states the figure the deletion actually freed, including zero. Every other outcome —
  // refused, failed, or no receipt at all — means bytes are still on disk, and the sentence says that
  // instead of implying a release that did not happen.
  if (notebookData?.state === 'removed') {
    return t('ws.sessionDeletedReleased', {
      title,
      size: formatBytes(notebookData.freedBytes, lang)
    })
  }
  if (notebookData?.state === 'absent') {
    return t('ws.sessionDeletedNothingStored', { title })
  }
  return t('ws.sessionDeletedRunDataKept', { title })
}
