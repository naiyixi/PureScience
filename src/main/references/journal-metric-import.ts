import {
  prepareJournalMetricCandidates,
  validateJournalMetricRow,
  type JournalMetricImportCandidate,
  type JournalMetricImportOutcome,
  type JournalMetricImportRequest,
  type JournalMetricImportResult,
  type JournalMetricRowProblem
} from '../../shared/journal-metrics'
import type { JournalMatch, JournalRepository } from './journal-repository'

// Imports a publisher's metric table into the journal library (R2, the first real producer of
// `JournalMetric`). The ports are the repository itself, narrowed to the five calls this owner makes, so the
// semantics below can be tested against a stub without an engine.
export type JournalMetricImportPorts = {
  journals: Pick<
    JournalRepository,
    'resolveJournal' | 'upsertByIssn' | 'upsertByNormalizedName' | 'appendMetric' | 'findMetric'
  >
}

export type JournalMetricImportOwner = {
  importMetrics(request: JournalMetricImportRequest): Promise<JournalMetricImportResult>
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// The outcome's field says which rule IDENTIFIED the journal, so only the three resolving rules belong there.
// A journal with an id can only have come from one of them — if that ever stops being true the import must say
// so instead of relabelling the row (`no-issn` would read as "identified by nothing" on an identified row).
const isResolvingMatch = (
  match: JournalMatch
): match is 'by-issn' | 'by-normalized-name' | 'by-alias' =>
  match === 'by-issn' || match === 'by-normalized-name' || match === 'by-alias'

// A refusal the repository raises is a JUDGEMENT about the row, so it becomes a named row reason. Anything
// else is not: an engine failure is not a verdict on a row, and recording it as one would hide a broken
// import behind a report full of plausible reasons. So it propagates. Re-running after such a failure is
// safe — an identical claim is recognised as a duplicate rather than appended twice.
const refusalReason = (error: unknown): JournalMetricRowProblem | null => {
  const message = detailOf(error)
  if (/matches \d+ journals/.test(message)) return 'name-ambiguous'
  if (/requires a usable venue name/.test(message)) return 'name-missing'
  if (/requires a well-formed ISSN/.test(message)) return 'bad-issn'

  return null
}

const outcomeBase = (candidate: JournalMetricImportCandidate): { index: number; line?: number } =>
  candidate.line === undefined
    ? { index: candidate.index }
    : { index: candidate.index, line: candidate.line }

export const createJournalMetricImportOwner = (
  ports: JournalMetricImportPorts
): JournalMetricImportOwner => ({
  importMetrics: async (request) => {
    const candidates = prepareJournalMetricCandidates(request)
    const outcomes: JournalMetricImportOutcome[] = []
    let imported = 0
    let skipped = 0
    let journalsCreated = 0

    for (const candidate of candidates) {
      const base = outcomeBase(candidate)
      const skip = (reason: JournalMetricRowProblem, detail: string): void => {
        outcomes.push({ ...base, status: 'skipped', reason, detail })
        skipped += 1
      }
      if (candidate.problem || !candidate.row) {
        skip(candidate.problem ?? 'malformed-row', candidate.detail ?? 'the row could not be read')
        continue
      }
      const validation = validateJournalMetricRow(candidate.row)
      if (!validation.ok) {
        skip(validation.reason, validation.detail)
        continue
      }
      const row = validation.row

      try {
        const resolution = await ports.journals.resolveJournal({
          issn: row.issn,
          venue: row.journalName
        })
        if (resolution.match === 'ambiguous') {
          // Two journals share this normalized name. Picking one would be the silent merge the library
          // exists to prevent, so the row is refused with the reason instead.
          skip(
            'name-ambiguous',
            `journal ${JSON.stringify(row.journalName)} matches more than one journal`
          )
          continue
        }

        let journalId = resolution.journalId
        let journalMatch: JournalMatch = resolution.match
        let journalCreated = false
        if (!journalId) {
          if (!row.journalName) {
            skip(
              'name-missing',
              `ISSN ${row.issn} is not registered yet and this row carries no journal name to register it with`
            )
            continue
          }
          // Registering the journal is deliberate here: the file names it and dates/sources the number, which
          // is precisely the case `upsertByNormalizedName` exists for. The resolution path used by references
          // never does this — there, a bare venue string is not an identity.
          const record = row.issn
            ? await ports.journals.upsertByIssn({ issn: row.issn, venue: row.journalName })
            : await ports.journals.upsertByNormalizedName({ venue: row.journalName })
          journalId = record.id
          journalCreated = true
          // A journal with an id cannot be an unresolved match: only the two resolving reasons set an id.
          journalMatch = row.issn ? 'by-issn' : 'by-normalized-name'
        }

        const duplicate = await ports.journals.findMetric({
          journalId,
          kind: row.kind,
          value: row.value,
          year: row.year,
          source: row.source
        })
        if (duplicate) {
          skip(
            'duplicate',
            `metric ${duplicate.id} already records ${row.kind} ${row.value} (${row.year}, ${row.source})`
          )
          continue
        }

        const metric = await ports.journals.appendMetric({
          journalId,
          kind: row.kind,
          value: row.value,
          year: row.year,
          source: row.source,
          ...(row.note ? { note: row.note } : {})
        })
        // Fail loudly rather than relabel: only a resolving rule can accompany a journal id.
        if (!isResolvingMatch(journalMatch)) {
          throw new Error(
            `journal ${journalId} was resolved with ${journalMatch}, which does not identify a journal`
          )
        }

        outcomes.push({
          ...base,
          status: 'imported',
          kind: row.kind,
          value: row.value,
          year: row.year,
          source: row.source,
          journalId,
          journalMatch,
          journalCreated,
          metricId: metric.id
        })
        imported += 1
        if (journalCreated) journalsCreated += 1
      } catch (error) {
        const reason = refusalReason(error)
        if (!reason) throw error
        skip(reason, detailOf(error))
      }
    }

    return { imported, skipped, journalsCreated, outcomes }
  }
})
