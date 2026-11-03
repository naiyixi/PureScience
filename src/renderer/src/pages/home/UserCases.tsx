import { ArrowUpRight, FileText, FlaskConical } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useDialogFocusRestore } from '@/components/ui/dialog-focus-restore'
import { useLanguage } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'

import type { ProjectCaseEvidence } from './user-case-evidence'
import {
  caseFileNames,
  caseFilesFromEvidence,
  footprintFromEvidence,
  loadCaseEvidence,
  loadCaseOverview
} from './user-case-evidence'
import type { CaseDomain, UserCase } from './user-cases'
import {
  CASE_DOMAINS,
  CURATED_CASE_TITLES,
  classifyDomain,
  deriveCaseName,
  filterCases,
  formatCaseBytes,
  judgeStanding,
  sortCases
} from './user-cases'

// 用户案例 / User cases — the home page's showcase of what this machine actually produced.
//
// This replaces the earlier plaza, which answered one question ("did anything run here?") with a card.
// A case now has to answer three: what is it called, what did it produce, and could someone else re-run
// it. So a card carries a name of the case's own (never the project folder), the standing its files
// earn, and — behind a click — the files it hands over.
//
// The section is presented the way a case market is: a search box, one chip per field, and cards that
// open into a detail panel. What it deliberately does *not* do is claim completeness: the Files
// catalogue is read for at most `CASE_SCAN_LIMIT` projects, and when that cap bites the header says so
// rather than letting a truncated list read as "these are all your cases".
//
// The `data-slot` names stay `case-plaza*`: the packaged certification lane
// (`e2e/certification/home-case-plaza.spec.ts`) binds to them, and the claims it certifies — a session
// earns a card, a project without one does not, the card opens the project — are still exactly the
// claims this component makes.

const CASE_SCAN_LIMIT = 18
const OVERVIEW_CONCURRENCY = 6
const EVIDENCE_CONCURRENCY = 4

const domainLabelKey = (domain: CaseDomain): TranslationKey =>
  `home.userCases.domain.${domain}` as TranslationKey

const standingLabelKey = (standing: UserCase['standing']): TranslationKey =>
  standing === 'reproducible'
    ? 'home.userCases.standing.reproducible'
    : 'home.userCases.standing.conversationOnly'

const cardClassName =
  'group flex h-full flex-col gap-2 rounded-2xl border border-border-200/70 bg-bg-000 p-4 text-left shadow-card transition-colors duration-150 ease-out hover:border-text-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

type CaseWithEvidence = UserCase & { evidence?: ProjectCaseEvidence }

const CaseDetail = ({
  item,
  onClose,
  onOpen
}: {
  item: CaseWithEvidence | undefined
  onClose: () => void
  onOpen: (projectId: string) => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const focusRestore = useDialogFocusRestore(Boolean(item))
  const open = Boolean(item)
  const caseFiles = caseFilesFromEvidence(item?.evidence)
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName('max-h-[80vh] w-[min(680px,92vw)] overflow-y-auto')}
          data-slot="case-plaza-detail"
          onOpenAutoFocus={focusRestore.onOpenAutoFocus}
          onCloseAutoFocus={focusRestore.onCloseAutoFocus}
        >
          {item ? (
            <>
              <div className={dialogHeaderClassName}>
                <div className="min-w-0">
                  <Dialog.Title className={dialogTitleClassName}>{item.name}</Dialog.Title>
                  <Dialog.Description className={dialogDescriptionClassName}>
                    {t(domainLabelKey(item.domain))} · {t(standingLabelKey(item.standing))}
                    {item.lastActive === undefined
                      ? ''
                      : ` · ${t('home.userCases.lastActive', {
                          when: formatRelativeTime(item.lastActive)
                        })}`}
                  </Dialog.Description>
                </div>
                <Dialog.Close
                  className={dialogCloseButtonClassName}
                  aria-label={t('home.userCases.detail.close')}
                >
                  ✕
                </Dialog.Close>
              </div>

              <p className="mt-4 text-sm text-text-100">
                {t('home.userCases.readings', {
                  artifacts: String(item.footprint.artifactCount),
                  files: String(item.footprint.fileCount),
                  size: formatCaseBytes(item.footprint.totalBytes)
                })}
              </p>

              <h4 className="mt-5 text-sm font-semibold text-text-000">
                {t('home.userCases.detail.files')}
              </h4>
              {caseFiles.length > 0 ? (
                <>
                  <ul className="mt-2 divide-y divide-border-200/60 rounded-xl border border-border-200/70">
                    {caseFiles.map((file) => (
                      <li key={file.name} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <FileText aria-hidden className="size-4 shrink-0 text-text-300" />
                        <span className="min-w-0 flex-1 truncate text-text-000" title={file.name}>
                          {file.name}
                        </span>
                        <span className="shrink-0 text-xs uppercase text-text-300">
                          {file.kind}
                        </span>
                        <span className="w-20 shrink-0 text-right text-xs tabular-nums text-text-300">
                          {formatCaseBytes(file.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-text-300">{t('home.userCases.detail.hint')}</p>
                </>
              ) : (
                <p className="mt-2 text-sm text-text-300">
                  {item.evidence === undefined
                    ? t('home.userCases.detail.unavailable')
                    : t('home.userCases.detail.noFiles')}
                </p>
              )}

              <div className={`${dialogFooterClassName} sticky bottom-0 bg-card`}>
                <button
                  type="button"
                  className="rounded-lg border border-border-200/70 px-3 py-1.5 text-sm text-text-000 transition-colors hover:border-text-300/60"
                  onClick={() => onOpen(item.projectId)}
                  data-slot="case-plaza-detail-open"
                >
                  {t('home.userCases.detail.open')}
                </button>
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export const UserCases = (): React.JSX.Element => {
  const { t } = useLanguage()
  const projects = useProjectStore((state) => state.projects)
  const sessions = useSessionStore((state) => state.sessions)
  const openProject = useNavigationStore((state) => state.openProject)

  const [overviews, setOverviews] = useState<Record<string, number | undefined>>({})
  const [counted, setCounted] = useState<Record<string, boolean>>({})
  const [evidence, setEvidence] = useState<Record<string, ProjectCaseEvidence | undefined>>({})
  const [resolved, setResolved] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState<CaseDomain | 'all'>('all')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const scanToken = useRef(0)

  // Candidates: a project appears because it ran a session here — the only admission rule the home page
  // has ever had. Examples and archived projects are not the reader's work, so they are not cases.
  const candidates = useMemo(() => {
    const byProject = new Map<string, { count: number; last?: number }>()
    for (const session of sessions as Array<{
      projectId: string
      createdAt?: number
      updatedAt?: number
    }>) {
      const entry = byProject.get(session.projectId) ?? { count: 0, last: undefined }
      entry.count += 1
      const stamp = session.updatedAt ?? session.createdAt
      if (stamp && (!entry.last || stamp > entry.last)) entry.last = stamp
      byProject.set(session.projectId, entry)
    }

    return projects
      .filter((project) => project.archivedAt === undefined && !project.isExample)
      .flatMap((project) => {
        const entry = byProject.get(project.id)
        if (!entry || entry.count === 0) return []
        const last = Math.max(entry.last ?? 0, project.updatedAt ?? 0) || undefined
        return [{ project, sessions: entry.count, last }]
      })
      .sort((left, right) => (right.last ?? 0) - (left.last ?? 0))
  }, [projects, sessions])

  // Phase 1 — a count for every project that ran, so the shortlist is chosen by how much a project
  // produced rather than by how recently it happened to move. Six at a time; the section fills in.
  const candidateIds = candidates.map((entry) => entry.project.id).join('\u0000')
  const overviewToken = useRef(0)

  useEffect(() => {
    const ids = candidateIds ? candidateIds.split('\u0000') : []
    if (ids.length === 0) return
    const token = overviewToken.current + 1
    overviewToken.current = token
    let cancelled = false

    const run = async (): Promise<void> => {
      for (let index = 0; index < ids.length; index += OVERVIEW_CONCURRENCY) {
        if (cancelled || overviewToken.current !== token) return
        const batch = ids.slice(index, index + OVERVIEW_CONCURRENCY)
        const results = await Promise.all(
          batch.map((projectId) => loadCaseOverview(projectId).catch(() => undefined))
        )
        if (cancelled || overviewToken.current !== token) return
        setOverviews((current) => {
          const next = { ...current }
          batch.forEach((projectId, offset) => {
            next[projectId] = results[offset]?.artifactCount
          })
          return next
        })
        setCounted((current) => {
          const next = { ...current }
          for (const projectId of batch) next[projectId] = true
          return next
        })
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [candidateIds])

  // The shortlist: counted projects first, ordered by artifact count then recency. A project whose count
  // read failed is still eligible, at the end — a failed read must not delete a case from the page.
  const scanned = useMemo(() => {
    const ready = candidates.filter((entry) => counted[entry.project.id])
    const pinned = (projectId: string): number => (CURATED_CASE_TITLES[projectId] ? 0 : 1)
    const ranked = [...ready].sort((left, right) => {
      const byPin = pinned(left.project.id) - pinned(right.project.id)
      if (byPin !== 0) return byPin
      const leftCount = overviews[left.project.id]
      const rightCount = overviews[right.project.id]
      const byCount = (rightCount ?? -1) - (leftCount ?? -1)
      if (byCount !== 0) return byCount
      return (right.last ?? 0) - (left.last ?? 0)
    })
    return ranked.slice(0, CASE_SCAN_LIMIT)
  }, [candidates, counted, overviews])

  const scannedIds = scanned.map((entry) => entry.project.id).join('\u0000')

  // Phase 2 — the file listing for the shortlist only, four at a time. Each card appears as soon as its
  // own read lands, so a slow project never holds the whole section hostage.
  useEffect(() => {
    const ids = scannedIds ? scannedIds.split('\u0000') : []
    if (ids.length === 0) return
    const token = scanToken.current + 1
    scanToken.current = token
    let cancelled = false

    const run = async (): Promise<void> => {
      for (let index = 0; index < ids.length; index += EVIDENCE_CONCURRENCY) {
        if (cancelled || scanToken.current !== token) return
        const batch = ids.slice(index, index + EVIDENCE_CONCURRENCY)
        const results = await Promise.all(
          batch.map((projectId) => loadCaseEvidence(projectId).catch(() => undefined))
        )
        if (cancelled || scanToken.current !== token) return
        setEvidence((current) => {
          const next = { ...current }
          batch.forEach((projectId, offset) => {
            next[projectId] = results[offset]
          })
          return next
        })
        setResolved((current) => {
          const next = { ...current }
          for (const projectId of batch) next[projectId] = true
          return next
        })
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [scannedIds])

  const cases = useMemo<CaseWithEvidence[]>(() => {
    const built: CaseWithEvidence[] = []
    for (const entry of scanned) {
      if (!resolved[entry.project.id]) continue
      const projectEvidence = evidence[entry.project.id]
      const footprint = footprintFromEvidence(projectEvidence, entry.sessions)
      const files = caseFileNames(projectEvidence)
      const named = deriveCaseName({
        projectId: entry.project.id,
        projectName: entry.project.name,
        description: entry.project.description,
        files
      })
      built.push({
        projectId: entry.project.id,
        name: named.name || t('home.userCases.untitled'),
        nameSource: named.source,
        domain: classifyDomain(files),
        standing: judgeStanding(footprint),
        footprint,
        lastActive: entry.last,
        files: caseFilesFromEvidence(projectEvidence),
        evidence: projectEvidence
      })
    }
    return sortCases(built)
  }, [scanned, resolved, evidence, t])

  const domainsPresent = useMemo(() => {
    const present = new Set(cases.map((item) => item.domain))
    return CASE_DOMAINS.filter((candidate) => present.has(candidate))
  }, [cases])

  const visible = useMemo(() => filterCases(cases, { query, domain }), [cases, query, domain])
  const selectedCase = visible.find((item) => item.projectId === selected)
  const hiddenByCap = Math.max(0, candidates.length - scanned.length)

  const openCase = (projectId: string): void => {
    setSelected(undefined)
    openProject(projectId)
  }

  if (candidates.length === 0) {
    return (
      <section className="mt-8" aria-label={t('home.userCases.title')} data-slot="case-plaza">
        <h3 className="text-sm font-semibold text-text-000">{t('home.userCases.title')}</h3>
        <p className="mt-2 text-sm text-text-300" data-slot="case-plaza-empty">
          {t('home.userCases.empty')}
        </p>
      </section>
    )
  }

  return (
    <section className="mt-8" aria-label={t('home.userCases.title')} data-slot="case-plaza">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-000">
            <FlaskConical aria-hidden className="size-4 text-text-300" />
            {t('home.userCases.title')}
          </h3>
          <p className="mt-1 text-sm text-text-300">{t('home.userCases.subtitle')}</p>
        </div>
        <span className="text-xs text-text-300" data-slot="case-plaza-count">
          {t('home.userCases.count', { count: String(cases.length) })}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('home.userCases.search')}
          aria-label={t('home.userCases.search')}
          data-slot="case-plaza-search"
          className="w-64 rounded-lg border border-border-200/70 bg-bg-000 px-3 py-1.5 text-sm text-text-000 outline-none placeholder:text-text-300 focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('home.userCases.title')}>
          {(['all', ...domainsPresent] as Array<CaseDomain | 'all'>).map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={domain === candidate}
              onClick={() => setDomain(candidate)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                domain === candidate
                  ? 'border-text-300/60 bg-bg-100 text-text-000'
                  : 'border-border-200/70 text-text-300 hover:border-text-300/60'
              }`}
            >
              {candidate === 'all'
                ? t('home.userCases.domain.all')
                : t(domainLabelKey(candidate as CaseDomain))}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="mt-4 text-sm text-text-300" data-slot="case-plaza-none">
          {t('home.userCases.noneMatch')}
        </p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((item) => (
            <li key={item.projectId} className="min-w-0">
              <button
                type="button"
                onClick={() => setSelected(item.projectId)}
                data-slot="case-plaza-card"
                data-project-id={item.projectId}
                data-standing={item.standing}
                className={cardClassName}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="line-clamp-2 min-h-[2.75em] min-w-0 text-sm font-semibold leading-snug text-text-000">
                    {item.name}
                  </span>
                  <ArrowUpRight
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-text-300 transition-colors group-hover:text-text-000"
                  />
                </span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span
                    className={`rounded-full px-2 py-0.5 ${
                      item.standing === 'reproducible'
                        ? 'bg-bg-100 text-text-000'
                        : 'bg-bg-000 text-text-300 ring-1 ring-border-200/70'
                    }`}
                  >
                    {t(standingLabelKey(item.standing))}
                  </span>
                  <span className="text-text-300">{t(domainLabelKey(item.domain))}</span>
                </span>
                <span className="text-xs tabular-nums text-text-300">
                  {t('home.userCases.readings', {
                    artifacts: String(item.footprint.artifactCount),
                    files: String(item.footprint.fileCount),
                    size: formatCaseBytes(item.footprint.totalBytes)
                  })}
                </span>
                <span className="mt-auto text-xs text-text-300">
                  {item.lastActive === undefined
                    ? t('home.userCases.ranHere')
                    : t('home.userCases.lastActive', {
                        when: formatRelativeTime(item.lastActive)
                      })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {hiddenByCap > 0 ? (
        <p className="mt-3 text-xs text-text-300" data-slot="case-plaza-capped">
          {t('home.userCases.scannedNote', {
            shown: String(scanned.length),
            total: String(candidates.length)
          })}
        </p>
      ) : null}

      <CaseDetail item={selectedCase} onClose={() => setSelected(undefined)} onOpen={openCase} />
    </section>
  )
}
