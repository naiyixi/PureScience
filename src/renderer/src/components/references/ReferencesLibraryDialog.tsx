import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookMarked, Library, Plus, RefreshCw, X } from 'lucide-react'

import { useLanguage } from '@/i18n'
import type {
  AddReferenceResult,
  CreateReferenceInput,
  Reference,
  ReferenceCollection
} from '../../../../shared/references'
import {
  formatGbt7714,
  formatGbt7714List,
  normalizeTitleForDedupe
} from '../../../../shared/references'

const IDENTIFIER_KINDS = ['doi', 'pmid', 'pmcid', 'arxivId'] as const
type IdentifierKind = (typeof IDENTIFIER_KINDS)[number]

const addReference = async (
  projectId: string,
  input: Omit<CreateReferenceInput, 'projectId'>
): Promise<AddReferenceResult> => window.api.references.add({ ...input, projectId })

// Client-side duplicate grouping: same DOI/PMID/arXiv or normalized-title collisions.
const groupDuplicates = (references: Reference[]): Reference[][] => {
  const groups: Reference[][] = []
  const used = new Set<string>()
  for (const reference of references) {
    if (used.has(reference.id)) continue
    const identity = new Set(
      [reference.doi, reference.pmid, reference.pmcid, reference.arxivId]
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.trim().toLowerCase())
    )
    const titleKey = normalizeTitleForDedupe(reference.title)
    const group = references.filter((candidate) => {
      if (candidate.id === reference.id || used.has(candidate.id)) return false
      const candidateIdentity = new Set(
        [candidate.doi, candidate.pmid, candidate.pmcid, candidate.arxivId]
          .filter((value): value is string => Boolean(value?.trim()))
          .map((value) => value.trim().toLowerCase())
      )
      return (
        (identity.size > 0 && [...identity].some((id) => candidateIdentity.has(id))) ||
        (titleKey.length > 0 && normalizeTitleForDedupe(candidate.title) === titleKey)
      )
    })
    if (group.length > 0) {
      used.add(reference.id)
      group.forEach((item) => used.add(item.id))
      groups.push([reference, ...group])
    }
  }
  return groups
}

const citationText = (reference: Reference): string => {
  const authors =
    reference.authors.length > 0
      ? reference.authors
          .slice(0, 3)
          .map((author) => author.name)
          .join(', ') + (reference.authors.length > 3 ? ' et al.' : '')
      : ''
  const venueYear = [reference.venue, reference.year].filter(Boolean).join(', ')
  const doi = reference.doi ? `. ${reference.doi}` : ''
  return `${authors}. ${reference.title}. ${venueYear}${doi}`
}

export function ReferencesLibraryDialog({
  open,
  onClose,
  projectId
}: {
  open: boolean
  onClose: () => void
  projectId: string | undefined
}): React.JSX.Element | null {
  const { t } = useLanguage()
  const [references, setReferences] = useState<Reference[]>([])
  const [collections, setCollections] = useState<ReferenceCollection[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  // Identifier-import state.
  const [kind, setKind] = useState<IdentifierKind>('doi')
  const [identifier, setIdentifier] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetched, setFetched] = useState<CreateReferenceInput | null>(null)

  // New-collection + manual-add state.
  const [newCollectionName, setNewCollectionName] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [manualTitle, setManualTitle] = useState('')
  const [manualDoi, setManualDoi] = useState('')
  const [manualYear, setManualYear] = useState('')
  const [manualAuthors, setManualAuthors] = useState('')
  // PDF attachment picker state (project-managed PDFs back page-level annotations).
  const [attachTargetId, setAttachTargetId] = useState<string | null>(null)
  const [pdfCandidates, setPdfCandidates] = useState<{ id: string; name: string }[]>([])
  const [pdfLoading, setPdfLoading] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) return
    try {
      const [items, folders] = await Promise.all([
        window.api.references.list(projectId),
        window.api.references.listCollections(projectId)
      ])
      setReferences(items)
      setCollections(folders)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [projectId])

  useEffect(() => {
    if (!open || !projectId) return
    let alive = true
    void Promise.all([
      window.api.references.list(projectId),
      window.api.references.listCollections(projectId)
    ])
      .then(([items, folders]) => {
        if (!alive) return
        setReferences(items)
        setCollections(folders)
        setError(undefined)
      })
      .catch((cause: unknown) => {
        if (!alive) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [open, projectId])

  const shownReferences = useMemo(() => {
    if (selectedCollectionId === null) return references
    return references.filter(
      (reference) => reference.collectionIds?.includes(selectedCollectionId) ?? false
    )
  }, [references, selectedCollectionId])

  if (!open) return null

  const todayIso = (): string => new Date().toISOString().slice(0, 10)

  const handleExportGbt7714 = async (): Promise<void> => {
    if (shownReferences.length === 0) {
      setNotice(t('references.noDuplicates'))
      return
    }
    const text = formatGbt7714List(shownReferences, { retrievedAt: todayIso() })
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `references-gbt7714-${todayIso()}.txt`
    link.click()
    URL.revokeObjectURL(url)
    setNotice(t('references.gbtExported', { n: shownReferences.length }))
  }

  const runAdd = async (input: Omit<CreateReferenceInput, 'projectId'>): Promise<void> => {
    try {
      const result = await addReference(projectId ?? '', input)
      if (result.status === 'created') {
        setNotice(t('references.addedNotice', { key: result.reference.citationKey }))
        setFetched(null)
        setManualTitle('')
        setManualDoi('')
        setManualYear('')
        setManualAuthors('')
        await refresh()
      } else {
        setError(t('references.duplicateNotice', { n: result.duplicateOf.length }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleFetch = async (): Promise<void> => {
    if (!identifier.trim()) return
    setFetching(true)
    setError(undefined)
    try {
      const found = await window.api.references.fetchByIdentifier(kind, identifier.trim())
      if (!found) {
        setError(t('references.notFound'))
        setFetched(null)
      } else {
        setFetched(found)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setFetching(false)
    }
  }

  const handleMergeDuplicates = async (): Promise<void> => {
    const groups = groupDuplicates(references)
    if (groups.length === 0) {
      setNotice(t('references.noDuplicates'))
      return
    }
    for (const group of groups) {
      const [keeper, ...rest] = group
      try {
        await window.api.references.merge(
          keeper.id,
          rest.map((item) => item.id)
        )
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    setNotice(t('references.merged', { n: groups.length }))
    await refresh()
  }

  const handleAddToCollection = async (
    referenceId: string,
    collectionId: string
  ): Promise<void> => {
    try {
      await window.api.references.addToCollection(collectionId, referenceId)
      setNotice(t('references.addedToCollection'))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const loadPdfCandidates = async (projectId: string): Promise<void> => {
    setPdfLoading(true)
    try {
      const page = await window.api.projectFiles.listFiles({
        projectId,
        collection: { kind: 'all' },
        limit: 500
      })
      const pdfs = page.items.filter(
        (item) =>
          item.name.toLowerCase().endsWith('.pdf') ||
          item.mimeType?.toLowerCase() === 'application/pdf'
      )
      setPdfCandidates(pdfs.map((item) => ({ id: item.id, name: item.name })))
      if (pdfs.length === 0) setError(t('references.notFound'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPdfLoading(false)
    }
  }

  const handleAttachPdf = async (referenceId: string, fileId: string): Promise<void> => {
    try {
      await window.api.references.attachPdf(referenceId, fileId)
      setAttachTargetId(null)
      setPdfCandidates([])
      setNotice(t('references.addedToCollection'))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleDetachPdf = async (referenceId: string): Promise<void> => {
    try {
      await window.api.references.detachPdf(referenceId)
      setNotice(t('references.addedToCollection'))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const buttonClass =
    'inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-foreground)] hover:opacity-90 disabled:opacity-50'
  const ghostClass =
    'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--muted-foreground)] hover:bg-[var(--border)]'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('references.title')}
      className="fixed inset-0 z-[95] flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="relative flex h-[82vh] w-[min(1080px,92vw)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
            <Library className="size-4" aria-hidden="true" /> {t('references.title')}
          </div>
          <button
            type="button"
            aria-label={t('references.close')}
            className={ghostClass}
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {/* Import strip */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as IdentifierKind)}
            className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            aria-label="DOI / PMID / PMCID / arXiv"
          >
            {IDENTIFIER_KINDS.map((value) => (
              <option key={value} value={value}>
                {value.toUpperCase()}
              </option>
            ))}
          </select>
          <input
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleFetch()
            }}
            placeholder={t('references.identifierPlaceholder')}
            className="w-72 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
          />
          <button
            type="button"
            className={buttonClass}
            disabled={fetching}
            onClick={() => void handleFetch()}
          >
            <RefreshCw className={`size-3 ${fetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            {fetching ? t('references.fetching') : t('references.fetch')}
          </button>
          <button type="button" className={ghostClass} onClick={() => setShowManual((v) => !v)}>
            <Plus className="size-3.5" aria-hidden="true" /> {t('references.manualAdd')}
          </button>
        </div>

        {fetched ? (
          <div className="mx-4 mt-2 flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-[var(--foreground)]">
                {fetched.title}
              </p>
              <p className="truncate text-[11px] text-[var(--muted-foreground)]">
                {(fetched.authors ?? []).map((author) => author.name).join(', ')}
                {fetched.year ? ` · ${fetched.year}` : ''}
                {fetched.venue ? ` · ${fetched.venue}` : ''}
              </p>
            </div>
            <button type="button" className={buttonClass} onClick={() => void runAdd(fetched)}>
              <BookMarked className="size-3" aria-hidden="true" /> {t('references.addToLibrary')}
            </button>
          </div>
        ) : null}

        {showManual ? (
          <div className="mx-4 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2">
            <input
              value={manualTitle}
              onChange={(event) => setManualTitle(event.target.value)}
              placeholder={t('references.manualTitlePlaceholder')}
              className="w-80 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            />
            <input
              value={manualAuthors}
              onChange={(event) => setManualAuthors(event.target.value)}
              placeholder={t('references.manualAuthorsPlaceholder')}
              className="w-64 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            />
            <input
              value={manualDoi}
              onChange={(event) => setManualDoi(event.target.value)}
              placeholder={t('references.manualDoiPlaceholder')}
              className="w-48 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            />
            <input
              value={manualYear}
              onChange={(event) => setManualYear(event.target.value)}
              placeholder={t('references.manualYearPlaceholder')}
              className="w-20 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            />
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                const year = Number.parseInt(manualYear, 10)
                void runAdd({
                  title: manualTitle,
                  authors: manualAuthors
                    .split(',')
                    .map((name) => name.trim())
                    .filter(Boolean)
                    .map((name) => ({ name })),
                  doi: manualDoi.trim() || undefined,
                  year: Number.isFinite(year) && manualYear.trim() !== '' ? year : undefined
                })
              }}
              disabled={!manualTitle.trim()}
            >
              {t('references.add')}
            </button>
          </div>
        ) : null}

        {error ? (
          <p
            className="mx-4 mt-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-400"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="mx-4 mt-2 rounded bg-emerald-500/10 px-2 py-1 text-xs text-emerald-400">
            {notice}
          </p>
        ) : null}

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {/* Collections */}
          <aside className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--border)] p-2">
            <button
              type="button"
              onClick={() => setSelectedCollectionId(null)}
              className={`rounded-md px-2 py-1 text-left text-xs ${
                selectedCollectionId === null
                  ? 'bg-[var(--accent)]/15 font-medium text-[var(--accent)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--border)]'
              }`}
            >
              {t('references.allItems', { n: references.length })}
            </button>
            {collections.map((collection) => (
              <button
                key={collection.id}
                type="button"
                onClick={() => setSelectedCollectionId(collection.id)}
                className={`rounded-md px-2 py-1 text-left text-xs ${
                  selectedCollectionId === collection.id
                    ? 'bg-[var(--accent)]/15 font-medium text-[var(--accent)]'
                    : 'text-[var(--muted-foreground)] hover:bg-[var(--border)]'
                }`}
              >
                {collection.name}
              </button>
            ))}
            <div className="mt-2 flex gap-1 border-t border-[var(--border)] pt-2">
              <input
                value={newCollectionName}
                onChange={(event) => setNewCollectionName(event.target.value)}
                placeholder={t('references.collectionNewPlaceholder')}
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !newCollectionName.trim() || !projectId) return
                  void window.api.references
                    .createCollection({ projectId, name: newCollectionName.trim() })
                    .then(() => {
                      setNewCollectionName('')
                      return refresh()
                    })
                }}
              />
            </div>
          </aside>

          {/* Items */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
              <span className="text-xs font-medium text-[var(--foreground)]">
                {selectedCollectionId === null
                  ? t('references.allItems', { n: shownReferences.length })
                  : (collections.find((c) => c.id === selectedCollectionId)?.name ?? '')}
              </span>
              <button
                type="button"
                className={ghostClass}
                onClick={() => void handleMergeDuplicates()}
              >
                <RefreshCw className="size-3" aria-hidden="true" /> {t('references.dedupe')}
              </button>
              <button
                type="button"
                className={ghostClass}
                onClick={() => void handleExportGbt7714()}
              >
                <BookMarked className="size-3" aria-hidden="true" /> {t('references.exportGbt')}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {shownReferences.length === 0 ? (
                <p className="py-10 text-center text-xs text-[var(--muted-foreground)]">
                  {t('references.empty')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {shownReferences.map((reference) => (
                    <li
                      key={reference.id}
                      className="group rounded-lg border border-[var(--border)] px-3 py-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-medium leading-snug text-[var(--foreground)]">
                            {reference.title}
                          </p>
                          <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
                            {reference.authors
                              .slice(0, 3)
                              .map((author) => author.name)
                              .join(', ')}
                            {reference.authors.length > 3 ? ' et al.' : ''}
                            {reference.year ? ` · ${reference.year}` : ''}
                            {reference.venue ? ` · ${reference.venue}` : ''}
                            {reference.doi ? ` · ${reference.doi}` : ''}
                            {reference.provenance ? ` · ${t('references.provenanceBadge')}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          {attachTargetId === reference.id ? (
                            <div className="flex items-center gap-1">
                              {pdfLoading ? (
                                <span className="text-[10px] text-[var(--muted-foreground)]">
                                  …
                                </span>
                              ) : (
                                <select
                                  className="max-w-36 rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-[10px]"
                                  aria-label="PDF"
                                  defaultValue=""
                                  onChange={(event) => {
                                    if (event.target.value) {
                                      void handleAttachPdf(reference.id, event.target.value)
                                    }
                                  }}
                                >
                                  <option value="" disabled>
                                    PDF…
                                  </option>
                                  {pdfCandidates.map((candidate) => (
                                    <option key={candidate.id} value={candidate.id}>
                                      {candidate.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                              <button
                                type="button"
                                className={ghostClass}
                                title="取消"
                                onClick={() => {
                                  setAttachTargetId(null)
                                  setPdfCandidates([])
                                }}
                              >
                                <X className="size-3" aria-hidden="true" />
                              </button>
                            </div>
                          ) : reference.pdfManagedFileId ? (
                            <span className="flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                              PDF · {reference.pdfManagedFileId.slice(-8)}
                              <button
                                type="button"
                                title="解除 PDF"
                                onClick={() => void handleDetachPdf(reference.id)}
                              >
                                <X className="size-3" aria-hidden="true" />
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className={ghostClass}
                              title="挂载 PDF（项目内 PDF 将可在文件面板中打开并做页码级标注）"
                              onClick={() => {
                                setAttachTargetId(reference.id)
                                if (projectId) void loadPdfCandidates(projectId)
                              }}
                            >
                              PDF
                            </button>
                          )}
                          <button
                            type="button"
                            className={ghostClass}
                            title={t('references.copyCitation')}
                            onClick={() => {
                              void navigator.clipboard.writeText(citationText(reference))
                              setNotice(t('references.citationCopied'))
                            }}
                          >
                            {t('references.copyCitation')}
                          </button>
                          <button
                            type="button"
                            className={ghostClass}
                            title={t('references.exportGbt')}
                            onClick={() => {
                              void navigator.clipboard.writeText(
                                formatGbt7714(reference, { retrievedAt: todayIso() })
                              )
                              setNotice(t('references.gbtCopied'))
                            }}
                          >
                            GB/T 7714
                          </button>
                          {collections.length > 0 ? (
                            <select
                              className="max-w-24 rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-[10px]"
                              aria-label={t('references.manualAdd')}
                              defaultValue=""
                              onChange={(event) => {
                                if (event.target.value) {
                                  void handleAddToCollection(reference.id, event.target.value)
                                }
                              }}
                            >
                              <option value="" disabled>
                                {t('references.collectionNewPlaceholder')}
                              </option>
                              {collections.map((collection) => (
                                <option key={collection.id} value={collection.id}>
                                  {collection.name}
                                </option>
                              ))}
                            </select>
                          ) : null}
                          <button
                            type="button"
                            className={ghostClass}
                            title="删除"
                            onClick={() => {
                              void window.api.references.remove(reference.id).then(refresh)
                            }}
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
