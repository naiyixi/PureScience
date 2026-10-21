import type { TranslationKey } from '@/i18n'
import type {
  SessionNotebookDataDeletion,
  SessionNotebookUsage
} from '../../../shared/session-persistence'
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
    // …unless the removal happened and nothing measured its bytes: then there is no figure to state, and
    // "0 B released" would be a claim about a directory nobody could look inside.
    if (notebookData.freedBytesState === 'unreadable') {
      return t('ws.sessionDeletedReleasedUnmeasured', { title })
    }
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

// The sentence the CONFIRMATION prints before an irreversible session delete. Same vocabulary as the
// receipt above, but it has to be honest in the one state a receipt never sees: a reading that does not
// exist yet. The confirmation is where the user decides, so it names what the action takes with it —
// deleting a session also releases `<dataRoot>/notebooks/<projectId>/<sessionId>`, which on a real
// installation held 1.1 GB of analysis results. `undefined` means "no reading to speak from" and the
// caller renders nothing rather than the "nothing to lose" claim.
export const sessionNotebookUsageMessage = (
  usage: SessionNotebookUsage | null,
  lang: string,
  t: Translate
): string | undefined => {
  if (!usage) return undefined
  if (usage.state === 'absent') return t('workspace.deleteSessionNoRunData')
  if (usage.state === 'unavailable') return t('workspace.deleteSessionRunDataUnmeasured')
  if (usage.bytes <= 0) return t('workspace.deleteSessionNoRunData')
  return t('workspace.deleteSessionRunData', { size: formatBytes(usage.bytes, lang) })
}
