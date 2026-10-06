import { useState } from 'react'

import { useLanguage, type TranslationKey } from '@/i18n'
import {
  JOURNAL_ALIAS_UNBIND_REFUSAL_LABEL_KEYS,
  isJournalAliasUnbindOutcome,
  type JournalAliasUnbindResult
} from '../../../../shared/journal-merge'
import type { JournalAliasRow } from '../../../../shared/journal-metrics-overview'

export type JournalAliasReleaseOutcome = {
  normalizedName: string
  result: JournalAliasUnbindResult
}

// Releasing a spelling a merge created — the merge's other half, and ONLY that half.
//
// The panel could already show the aliases (the `also known as …` chips in the table) but not undo one, so a
// name that a merge folded away stayed glued to the surviving journal forever. This control is that one way
// back, and it says in the confirmation — before anything happens — what it does and what it does NOT do:
// the metrics and references the merge re-attributed carry no record of their former journal, so there is
// nothing to move back, and nothing else is deleted. Saying only "release this name" would let a reader
// assume the merge itself is being undone.
//
// The alias is addressed by its stored key (a normalized name) — never by the text on screen, which is only a
// rendering of that key — so a control can never release a different name than the one it drew.
export function JournalAliasRelease({
  aliases,
  journalNames,
  busy,
  lastResult,
  onRelease
}: {
  aliases: readonly JournalAliasRow[]
  journalNames: ReadonlyMap<string, string>
  busy: boolean
  lastResult: JournalAliasReleaseOutcome | null
  onRelease: (normalizedName: string) => void
}): React.JSX.Element {
  const { t } = useLanguage()
  // The alias whose confirmation is open. One at a time: two open confirmations would make "it" ambiguous.
  const [pending, setPending] = useState<string | null>(null)

  // The store's own id is the fallback, never an invented name: a journal the list does not hold is a fact
  // about the list, not permission to print something plausible.
  const nameOf = (journalId: string): string => journalNames.get(journalId) ?? journalId

  return (
    <div
      className="flex flex-col gap-2 rounded border border-[var(--border)] p-2 text-xs"
      data-slot="journal-alias-release"
    >
      <div>
        <h4 className="text-xs font-medium">{t('references.journalMetrics.aliasUnbind.title')}</h4>
        <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
          {t('references.journalMetrics.aliasUnbind.hint')}
        </p>
      </div>

      <ul className="flex flex-col gap-1">
        {aliases.map((alias) => (
          <li
            className="flex flex-col gap-1"
            data-slot="journal-alias-release-row"
            key={alias.normalizedName}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span data-slot="journal-alias-release-name">{alias.normalizedName}</span>
              <span className="text-[10px] text-[var(--muted-foreground)]">
                {t('references.journalMetrics.aliasUnbind.resolvesTo', {
                  journal: nameOf(alias.journalId)
                })}
              </span>
              <button
                className="rounded border border-[var(--border)] px-2 py-0.5 disabled:opacity-50"
                data-slot="journal-alias-release-open"
                disabled={busy}
                onClick={() => setPending(alias.normalizedName)}
                type="button"
              >
                {t('references.journalMetrics.aliasUnbind.release')}
              </button>
            </div>

            {pending === alias.normalizedName ? (
              <div
                className="flex flex-col gap-1 rounded border border-[var(--border)] p-2"
                data-slot="journal-alias-release-confirm"
              >
                <p>
                  {t('references.journalMetrics.aliasUnbind.confirmDetail', {
                    name: alias.normalizedName,
                    journal: nameOf(alias.journalId)
                  })}
                </p>
                <div className="flex gap-2">
                  <button
                    className="rounded border border-[var(--border)] px-2 py-0.5 disabled:opacity-50"
                    data-slot="journal-alias-release-confirm-yes"
                    disabled={busy}
                    onClick={() => {
                      setPending(null)
                      onRelease(alias.normalizedName)
                    }}
                    type="button"
                  >
                    {busy
                      ? t('references.journalMetrics.aliasUnbind.releasing')
                      : t('references.journalMetrics.aliasUnbind.confirm')}
                  </button>
                  <button
                    className="rounded border border-[var(--border)] px-2 py-0.5"
                    data-slot="journal-alias-release-confirm-no"
                    onClick={() => setPending(null)}
                    type="button"
                  >
                    {t('references.journalMetrics.aliasUnbind.cancel')}
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {/* The store's own answer, not a restatement of the click: a success names the released spelling and the
          journal it no longer resolves to; a refusal prints the named reason beside the store's sentence. */}
      {lastResult === null ? null : isJournalAliasUnbindOutcome(lastResult.result) ? (
        <p className="text-[var(--accent)]" data-slot="journal-alias-release-done" role="status">
          {t('references.journalMetrics.aliasUnbind.done', {
            name: lastResult.result.normalizedName,
            journal: nameOf(lastResult.result.journalId)
          })}
        </p>
      ) : (
        <p className="text-[var(--accent)]" data-slot="journal-alias-release-refusal" role="alert">
          {t(JOURNAL_ALIAS_UNBIND_REFUSAL_LABEL_KEYS[lastResult.result.reason] as TranslationKey)} —{' '}
          {lastResult.result.detail}
        </p>
      )}
    </div>
  )
}
