import type { Translate } from '@/i18n'
import type { NotebookStaleReason } from '../../../shared/run-alias-lineage'

// The one place a stale-run reason becomes words. The shared analysis hands over DATA (which later
// run changed what, through which alias, on which line), so the sentence lives here where nine
// languages exist — a sentence composed in the shared layer could only ever be English.
//
// The marker itself ("stale") is deliberately left alone: this adds the reason beside it, and a run
// the analysis could not locate a site for still keeps its marker.

const translateKey = (t: Translate, key: string): string => (t as (key: string) => string)(key)

/**
 * The sentence shown next to the stale marker, or undefined when there is no located reason (an old
 * record can be stale without the analysis being able to say where it changed — silence beats a
 * guess).
 */
export const notebookStaleReasonText = (
  t: Translate,
  reason: NotebookStaleReason
): string | undefined => {
  if (reason.kind === 'name-rewrite') {
    return translateKey(t, 'notebookStale.rewrite').replace('{variable}', reason.variable)
  }
  if (reason.mutation === undefined) return undefined
  const line = String(reason.mutation.line)
  if (reason.kind === 'direct-mutation') {
    return translateKey(t, 'notebookStale.directMutation')
      .replace('{variable}', reason.variable)
      .replace('{line}', line)
  }
  return translateKey(t, 'notebookStale.aliasMutation')
    .replace('{variable}', reason.variable)
    .replace('{via}', reason.via)
    .replace('{line}', line)
}
