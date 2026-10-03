// Landing the evidence a session package carries.
//
// A package arrives with four required members: the conversation, the project's citations, the
// reviewer's findings and the human-pinned verification records. The conversation becomes a session
// document; the other three have to become rows in THIS machine's stores, or the receiver is handed a
// transcript with no evidence behind it.
//
// Three rules shape the code below, because the bytes come from another machine:
//   · every row is validated field by field — a package is input, not a promise;
//   · pointers that only mean something on the sending machine (artifact version ids, managed-file ids,
//     journal ids) are dropped rather than carried over as dangling references;
//   · a row that cannot be landed is NAMED in the landing report. A silent skip would make "refused"
//     and "there was nothing" look the same.
//
// Verification records are re-derived here rather than copied: a pin's fingerprint is computed from the
// block as THIS machine now stores it (the published `pinnedFilters`/sha256 recipe), using the message
// the imported transcript carries. A pin that could not be re-derived is refused by name — never stored
// with the sender's fingerprint, which nobody here could check.

import type {
  CreateReferenceInput,
  ReferenceAuthor,
  ReferenceItemType,
  ReferenceProvenance,
  ReferenceSourceConnector
} from '../../shared/references'
import type {
  CheckStatus,
  CreateReviewInput,
  FindingLocator,
  FindingResolution,
  NewCheck,
  ReviewLifecycle,
  ReviewOutcome,
  ReviewerLogEntry,
  ScopeBlock,
  TurnScope
} from '../../shared/reviewer'
import type {
  SearchEvidenceCaptureResult,
  SearchEvidenceReason
} from '../../shared/search-evidence'
import type {
  SessionPackageEvidenceKind,
  SessionPackageEvidenceLanding,
  SessionPackageEvidenceSkip,
  SessionPackageEvidenceSkipReason
} from '../../shared/session-package-import'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value
}

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const REFERENCE_CONNECTORS: readonly ReferenceSourceConnector[] = [
  'openalex',
  'pubmed',
  'arxiv',
  'europepmc',
  'manual'
]

const REFERENCE_ITEM_TYPES: readonly ReferenceItemType[] = [
  'journal-article',
  'conference-paper',
  'preprint',
  'book',
  'chapter',
  'report',
  'dataset',
  'thesis',
  'web'
]

const REVIEW_LIFECYCLES: readonly ReviewLifecycle[] = ['running', 'complete', 'error']
const REVIEW_OUTCOMES: readonly ReviewOutcome[] = ['pass', 'flagged']
const CHECK_STATUSES: readonly CheckStatus[] = ['pass', 'warn', 'fail']
const FINDING_RESOLUTIONS: readonly FindingResolution[] = ['open', 'resolved', 'unaddressed']

const oneOf = <Value extends string>(
  values: readonly Value[],
  value: unknown
): Value | undefined =>
  typeof value === 'string' ? values.find((candidate) => candidate === value) : undefined

const authorsOf = (value: unknown): ReferenceAuthor[] | undefined => {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const authors: ReferenceAuthor[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    const name = asText(entry.name)
    if (!name) return undefined
    const orcid = asText(entry.orcid)
    authors.push(orcid ? { name, orcid } : { name })
  }
  return authors
}

const provenanceOf = (value: unknown): ReferenceProvenance | undefined => {
  if (!isRecord(value)) return undefined
  const connector = oneOf(REFERENCE_CONNECTORS, value.connector)
  const fetchedAt = asText(value.fetchedAt)
  if (!connector || !fetchedAt) return undefined
  const sourceUrl = asText(value.sourceUrl)
  const sourceRecordId = asText(value.sourceRecordId)
  const snapshotJson = asText(value.snapshotJson)
  return {
    connector,
    fetchedAt,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceRecordId ? { sourceRecordId } : {}),
    ...(snapshotJson ? { snapshotJson } : {})
  }
}

/**
 * A packaged citation, as a `CreateReferenceInput` for the TARGET project.
 *
 * `pdfManagedFileId` is never carried (it points at a file on the sending machine), and the journal
 * link is recomputed by the receiving store from the venue/ISSN it can see — the sender's journal id
 * means nothing here. Nothing is invented to fill a gap: a missing field stays missing.
 */
const referenceInputOf = (
  row: unknown,
  targetProjectId: string
): (CreateReferenceInput & { citationKey: string }) | undefined => {
  if (!isRecord(row)) return undefined
  const title = asText(row.title)
  const citationKey = asText(row.citationKey)
  const authors = authorsOf(row.authors)
  if (!title || !citationKey || !authors) return undefined
  const venue = asText(row.venue)
  const year = asNumber(row.year)
  const volume = asText(row.volume)
  const issue = asText(row.issue)
  const pages = asText(row.pages)
  const itemType = oneOf(REFERENCE_ITEM_TYPES, row.itemType)
  const doi = asText(row.doi)
  const pmid = asText(row.pmid)
  const pmcid = asText(row.pmcid)
  const arxivId = asText(row.arxivId)
  const url = asText(row.url)
  const abstractSnippet = asText(row.abstractSnippet)
  const publisher = asText(row.publisher)
  const sourceConnector = oneOf(REFERENCE_CONNECTORS, row.sourceConnector) ?? 'manual'
  const sourceRecordId = asText(row.sourceRecordId)
  const notes = asText(row.notes)
  const provenance = provenanceOf(row.provenance)
  return {
    projectId: targetProjectId,
    title,
    citationKey,
    authors,
    sourceConnector,
    ...(venue ? { venue } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
    ...(publisher ? { publisher } : {}),
    ...(itemType ? { itemType } : {}),
    ...(doi ? { doi } : {}),
    ...(pmid ? { pmid } : {}),
    ...(pmcid ? { pmcid } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(url ? { url } : {}),
    ...(abstractSnippet ? { abstractSnippet } : {}),
    ...(sourceRecordId ? { sourceRecordId } : {}),
    ...(provenance ? { provenance } : {}),
    ...(notes ? { notes } : {})
  }
}

const scopeBlocksOf = (value: unknown): ScopeBlock[] => {
  if (!Array.isArray(value)) return []
  const blocks: ScopeBlock[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = asText(entry.id)
    const kind = entry.kind === 'message' || entry.kind === 'activity' ? entry.kind : undefined
    const sourceId = asText(entry.sourceId)
    const blockIndex = asNumber(entry.blockIndex)
    const contentHash = asText(entry.contentHash)
    if (!id || !kind || !sourceId || blockIndex === undefined || !contentHash) continue
    blocks.push({ id, kind, sourceId, blockIndex, contentHash })
  }
  return blocks
}

/**
 * The audited window, re-rooted on this machine: the turn id travels (the imported transcript carries
 * the same message), the blocks travel, and `artifactVersionIds` is emptied because those ids live in
 * the sender's artifact store. Findings are landed unbound for the same reason, so nothing here claims
 * a validated artifact binding.
 */
const turnScopeOf = (row: Record<string, unknown>, turnMessageId: string): TurnScope => {
  const scope = isRecord(row.scope) ? row.scope : {}
  const agentFrameId = asText(scope.agentFrameId)
  const messageBranchId = asText(scope.messageBranchId)
  return {
    turnMessageId,
    blocks: scopeBlocksOf(scope.blocks),
    artifactVersionIds: [],
    ...(agentFrameId ? { agentFrameId } : {}),
    ...(messageBranchId ? { messageBranchId } : {})
  }
}

const reviewerLogOf = (value: unknown): ReviewerLogEntry[] => {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is ReviewerLogEntry => {
    if (!isRecord(entry)) return false
    if (entry.kind === 'thought' || entry.kind === 'message') return typeof entry.text === 'string'
    return entry.kind === 'tool' && typeof entry.toolName === 'string'
  })
}

/** A packaged check, as a `NewCheck`. `artifactVersionId` is dropped: it names a version of the sender. */
const checkOf = (row: unknown, index: number): NewCheck | undefined => {
  if (!isRecord(row)) return undefined
  const status = oneOf(CHECK_STATUSES, row.status)
  const claim = asText(row.claim)
  if (!status || !claim) return undefined
  const evidence = asText(row.evidence) ?? ''
  const resolution = oneOf(FINDING_RESOLUTIONS, row.resolution)
  const sortIndex = asNumber(row.sortIndex)
  const locator = isRecord(row.locator) ? (row.locator as FindingLocator) : undefined
  return {
    status,
    claim,
    evidence,
    ...(locator ? { locator } : {}),
    ...(resolution ? { resolution } : {}),
    ...(sortIndex !== undefined ? { sortIndex } : { index })
  }
}

export type ImportedEvidencePorts = {
  /** The target project's citation keys, so a landing can refuse a key that is already taken. */
  listReferenceKeys: (projectId: string) => Promise<readonly string[]>
  createReference: (input: CreateReferenceInput & { citationKey: string }) => Promise<unknown>
  createReview: (input: CreateReviewInput) => Promise<{ id: string }>
  addFindings: (reviewId: string, findings: readonly NewCheck[]) => Promise<void>
  /**
   * Re-derives a line for a block THIS machine holds, with the published fingerprint recipe. The app's
   * own search-evidence service is the only producer of a fingerprint, here as everywhere else.
   */
  captureEvidence: (request: {
    projectId: string
    sessionId: string
    messageId: string
    query: string
    terms: readonly string[]
  }) => Promise<SearchEvidenceCaptureResult>
  appendReviewEvidence: (input: {
    reviewId: string
    projectId: string
    sessionId: string
    messageId: string
    role: 'user' | 'agent'
    fingerprint: string
    query: string
    terms: readonly string[]
    snippet: string
    capturedAt: Date
  }) => Promise<unknown>
}

export type ImportedEvidenceInput = {
  targetProjectId: string
  /** The id the imported session got here — pins are re-derived against THIS session. */
  sessionId: string
  /** Message ids the imported transcript carries; a row naming another message did not land. */
  messageIds: readonly string[]
  citations: readonly unknown[]
  reviewFindings: readonly unknown[]
  verificationRecords: readonly unknown[]
}

const skipped = (
  kind: SessionPackageEvidenceKind,
  reason: SessionPackageEvidenceSkipReason,
  id?: string
): SessionPackageEvidenceSkip => (id ? { kind, reason, id } : { kind, reason })

// A capture reports its own refusals; three of them are also landing refusals. Anything else (a
// fingerprint mismatch, which capture never returns) would mean a row this code cannot judge, so it is
// named as unreadable rather than relabelled into a reason that does not describe it.
const captureSkipReason = (reason: SearchEvidenceReason): SessionPackageEvidenceSkipReason =>
  reason === 'message-not-found' || reason === 'text-truncated' || reason === 'session-unavailable'
    ? reason
    : 'row-unreadable'

/**
 * Land a package's citations, review findings and verification records on this machine.
 *
 * Never throws and never silently drops: an unlandable row is reported with the name of the reason, so
 * the caller can say both how many rows arrived and which ones did not.
 */
export const landImportedEvidence = async (
  ports: ImportedEvidencePorts,
  input: ImportedEvidenceInput
): Promise<SessionPackageEvidenceLanding> => {
  const skippedRows: SessionPackageEvidenceSkip[] = []
  let citations = 0
  let reviews = 0
  let reviewFindings = 0
  let verificationRecords = 0

  // ---- Citations: the project's reference library ------------------------------------------------
  // Read once, then updated as rows land, so two identical keys inside ONE package cannot both land.
  // A failed read is not fatal: the store's own unique key still refuses a collision, and that refusal
  // is reported by name like any other.
  let takenKeys: Set<string>
  try {
    takenKeys = new Set(await ports.listReferenceKeys(input.targetProjectId))
  } catch {
    takenKeys = new Set()
  }
  for (const row of input.citations) {
    const parsed = referenceInputOf(row, input.targetProjectId)
    const rowId = isRecord(row) ? asText(row.citationKey) : undefined
    if (!parsed) {
      skippedRows.push(skipped('citations', 'row-unreadable', rowId))
      continue
    }
    if (takenKeys.has(parsed.citationKey)) {
      skippedRows.push(skipped('citations', 'reference-key-taken', parsed.citationKey))
      continue
    }
    try {
      await ports.createReference(parsed)
      takenKeys.add(parsed.citationKey)
      citations += 1
    } catch {
      skippedRows.push(skipped('citations', 'landing-failed', parsed.citationKey))
    }
  }

  // ---- Review findings: the reviewer's own checks, hanging off the imported turn ------------------
  const knownMessages = new Set(input.messageIds)
  const reviewIdBySourceId = new Map<string, string>()
  for (const row of input.reviewFindings) {
    const sourceId = isRecord(row) ? asText(row.id) : undefined
    if (!isRecord(row)) {
      skippedRows.push(skipped('review-findings', 'row-unreadable'))
      continue
    }
    const turnMessageId = asText(row.turnMessageId)
    const lifecycle = oneOf(REVIEW_LIFECYCLES, row.lifecycle)
    const outcome =
      row.outcome === null || row.outcome === undefined ? null : oneOf(REVIEW_OUTCOMES, row.outcome)
    if (!sourceId || !turnMessageId || !lifecycle || outcome === undefined) {
      skippedRows.push(skipped('review-findings', 'row-unreadable', sourceId))
      continue
    }
    if (!knownMessages.has(turnMessageId)) {
      skippedRows.push(skipped('review-findings', 'message-not-found', sourceId))
      continue
    }
    const checks = Array.isArray(row.checks) ? row.checks : []
    const findings: NewCheck[] = []
    checks.forEach((check, index) => {
      const parsed = checkOf(check, index)
      if (parsed) findings.push(parsed)
      else skippedRows.push(skipped('review-findings', 'row-unreadable', sourceId))
    })
    const model = asText(row.model) ?? ''
    try {
      const created = await ports.createReview({
        projectId: input.targetProjectId,
        sessionId: input.sessionId,
        turnMessageId,
        scope: turnScopeOf(row, turnMessageId),
        lifecycle,
        outcome,
        model,
        reviewerLog: reviewerLogOf(row.reviewerLog)
      })
      await ports.addFindings(created.id, findings)
      reviewIdBySourceId.set(sourceId, created.id)
      reviews += 1
      reviewFindings += findings.length
    } catch {
      skippedRows.push(skipped('review-findings', 'landing-failed', sourceId))
    }
  }

  // ---- Verification records: pins re-derived against the transcript this machine now holds --------
  for (const row of input.verificationRecords) {
    if (!isRecord(row)) {
      skippedRows.push(skipped('verifications', 'row-unreadable'))
      continue
    }
    const sourceReviewId = asText(row.reviewId)
    const messageId = asText(row.messageId)
    if (!sourceReviewId || !messageId) {
      skippedRows.push(skipped('verifications', 'row-unreadable', sourceReviewId))
      continue
    }
    const reviewId = reviewIdBySourceId.get(sourceReviewId)
    if (!reviewId) {
      skippedRows.push(skipped('verifications', 'review-not-imported', sourceReviewId))
      continue
    }
    // The sender's fingerprint is deliberately not carried: it was computed over the sender's session
    // id and would verify against nothing here. A pin is stored only with the fingerprint of the block
    // as this machine holds it — which is what makes it checkable by whoever reads it next.
    const query = asText(row.query) ?? ''
    const terms = Array.isArray(row.terms)
      ? row.terms.filter((term): term is string => typeof term === 'string' && term.trim() !== '')
      : []
    const capturedAt = asText(row.capturedAt)
    const captured = await ports
      .captureEvidence({
        projectId: input.targetProjectId,
        sessionId: input.sessionId,
        messageId,
        query,
        terms
      })
      .catch((): SearchEvidenceCaptureResult => ({
        status: 'unavailable',
        reason: 'session-unavailable'
      }))
    if (captured.status !== 'captured') {
      skippedRows.push(skipped('verifications', captureSkipReason(captured.reason), sourceReviewId))
      continue
    }
    try {
      await ports.appendReviewEvidence({
        reviewId,
        projectId: input.targetProjectId,
        sessionId: input.sessionId,
        messageId,
        role: captured.line.role,
        fingerprint: captured.line.fingerprint,
        query,
        terms,
        snippet: captured.line.snippet,
        capturedAt:
          capturedAt && !Number.isNaN(Date.parse(capturedAt)) ? new Date(capturedAt) : new Date()
      })
      verificationRecords += 1
    } catch {
      skippedRows.push(skipped('verifications', 'landing-failed', sourceReviewId))
    }
  }

  return { citations, reviews, reviewFindings, verificationRecords, skipped: skippedRows }
}
