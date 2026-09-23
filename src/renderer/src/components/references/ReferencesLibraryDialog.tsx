import { Dialog } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookMarked, Library, Plus, RefreshCw, X } from 'lucide-react'

import { useLanguage, type TranslationKey } from '@/i18n'
import { useDialogFocusRestore } from '@/components/ui/dialog-focus-restore'
import type {
  AddReferenceResult,
  CreateReferenceInput,
  Reference,
  ReferenceCollection
} from '../../../../shared/references'
import { normalizeTitleForDedupe } from '../../../../shared/references'
import {
  citationItemFromReference,
  compareCitationStyles,
  formatCitation,
  formatCitationList,
  missingFieldsFromWarnings,
  resolveCitationStyles
} from '../../../../shared/citation/format'
import {
  citationStyleFromImport,
  type ImportedCitationStyle
} from '../../../../shared/citation/csl'
import type { CitationStyleDefinition } from '../../../../shared/citation/types'

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

// Citation-style warning tokens are machine-readable (`field:volume`, `unsupported:sort`,
// `style:unknown`). Each one is shown as a sentence; an unknown token is surfaced verbatim rather
// than dropped, so a new token can never go unnoticed.
const CITATION_FIELD_LABELS: Record<string, string> = {
  authors: 'authors',
  containerTitle: 'containerTitle',
  year: 'year',
  volume: 'volume',
  issue: 'issue',
  pages: 'pages',
  publisher: 'publisher',
  doi: 'doi'
}

type TranslateFn = (key: TranslationKey, vars?: Record<string, string | number>) => string

const describeCitationWarning = (warning: string, t: TranslateFn): string => {
  if (warning.startsWith('field:')) {
    const field = warning.slice('field:'.length)
    return t('references.citationWarning.missingField', {
      field: CITATION_FIELD_LABELS[field] ?? field
    })
  }
  if (warning.startsWith('unsupported:')) {
    return t('references.citationWarning.unsupported', {
      name: warning.slice('unsupported:'.length)
    })
  }
  if (warning === 'fidelity:partial') return t('references.citationWarning.fidelityPartial')
  if (warning.startsWith('fidelity:missing:')) {
    return t('references.citationWarning.fidelityMissing', {
      field: warning.slice('fidelity:missing:'.length)
    })
  }
  if (warning === 'fidelity:render-empty') return t('references.citationWarning.emptyRender')
  switch (warning) {
    case 'style:unknown':
      return t('references.citationWarning.unknownStyle')
    case 'style:no-locator':
      return t('references.citationWarning.noLocator')
    case 'style:empty-render':
      return t('references.citationWarning.emptyRender')
    default:
      return warning
  }
}

const STYLE_REJECTION_KEYS: Record<string, TranslationKey> = {
  'xml-parse-failed': 'references.styleRejection.xmlParseFailed',
  'not-a-style': 'references.styleRejection.notAStyle',
  'missing-info': 'references.styleRejection.missingInfo',
  'missing-title': 'references.styleRejection.missingTitle',
  'missing-license': 'references.styleRejection.missingLicense',
  'missing-bibliography': 'references.styleRejection.missingBibliography',
  'builtin-id-collision': 'references.styleRejection.idCollision',
  'too-large': 'references.styleRejection.tooLarge'
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
  const focusRestore = useDialogFocusRestore(open)
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
  // PDF batch-import state: many project PDFs become library records (one record per file,
  // title from the filename, provenance recorded as a manual file import), each with its PDF
  // attached so it opens in the page-level annotation flow.
  const [pdfCandidates, setPdfCandidates] = useState<{ id: string; name: string }[]>([])
  const [pdfLoading, setPdfLoading] = useState(false)
  const [showPdfPicker, setShowPdfPicker] = useState(false)
  const [selectedPdfIds, setSelectedPdfIds] = useState<string[]>([])
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const cancelImportRef = useRef(false)
  const [attachToReferenceId, setAttachToReferenceId] = useState<string | null>(null)

  // Citation-style layer (v1.65): built-ins come from the shared catalogue, imported styles from the
  // store; both are merged here so one picker drives export, copy and the side-by-side comparison.
  const [importedStyles, setImportedStyles] = useState<ImportedCitationStyle[]>([])
  const [selectedStyleId, setSelectedStyleId] = useState<string>('gbt7714-2015')
  const [compareTarget, setCompareTarget] = useState<Reference | null>(null)
  const [styleBusy, setStyleBusy] = useState(false)
  const styleFileInputRef = useRef<HTMLInputElement | null>(null)

  const citationStyles = useMemo<readonly CitationStyleDefinition[]>(
    () => resolveCitationStyles(importedStyles.map((style) => citationStyleFromImport(style))),
    [importedStyles]
  )
  const selectedStyle = useMemo(
    () => citationStyles.find((style) => style.id === selectedStyleId) ?? citationStyles[0],
    [citationStyles, selectedStyleId]
  )

  const loadCitationStyles = useCallback(async (): Promise<void> => {
    try {
      setImportedStyles(await window.api.references.listCitationStyles())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const handleImportCitationStyle = async (file: File): Promise<void> => {
    setStyleBusy(true)
    setError(undefined)
    try {
      const xml = await file.text()
      const outcome = await window.api.references.importCitationStyle({
        fileName: file.name,
        xml
      })
      if (outcome.status === 'imported') {
        await loadCitationStyles()
        setSelectedStyleId(outcome.style.id)
        setNotice(
          outcome.replacedExisting
            ? t('references.styleReplaced', { label: outcome.style.label })
            : t('references.styleImported', {
                label: outcome.style.label,
                license: outcome.style.license
              })
        )
      } else {
        setError(
          t(STYLE_REJECTION_KEYS[outcome.reason] ?? 'references.styleRejection.unknown') +
            (outcome.detail ? ` (${outcome.detail})` : '')
        )
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStyleBusy(false)
    }
  }

  const handleRemoveCitationStyle = async (styleId: string): Promise<void> => {
    try {
      await window.api.references.removeCitationStyle(styleId)
      if (selectedStyleId === styleId) setSelectedStyleId('gbt7714-2015')
      await loadCitationStyles()
      setNotice(t('references.styleRemoved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

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
      window.api.references.listCollections(projectId),
      window.api.references.listCitationStyles()
    ])
      .then(([items, folders, styles]) => {
        if (!alive) return
        setReferences(items)
        setCollections(folders)
        setImportedStyles(styles)
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

  // Exports in whichever style is selected. The file name carries the style id so a saved list can be
  // traced back to the convention (and, for imports, to the exact imported style) that produced it.
  const handleExportWithStyle = async (): Promise<void> => {
    if (shownReferences.length === 0) {
      setNotice(t('references.noDuplicates'))
      return
    }
    const items = shownReferences.map((reference) => citationItemFromReference(reference))
    const text = formatCitationList(
      items,
      selectedStyleId,
      { retrievedAt: todayIso() },
      citationStyles
    )
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `references-${selectedStyleId.replace(/[^a-z0-9-]+/gi, '-')}-${todayIso()}.txt`
    link.click()
    URL.revokeObjectURL(url)
    setNotice(
      t('references.exportedWithStyle', {
        n: shownReferences.length,
        style: selectedStyle?.label ?? selectedStyleId
      })
    )
  }

  const handleCopyInStyle = async (reference: Reference): Promise<void> => {
    const formatted = formatCitation(
      citationItemFromReference(reference),
      selectedStyleId,
      { retrievedAt: todayIso() },
      citationStyles
    )
    await navigator.clipboard.writeText(formatted.text)
    setNotice(t('references.copiedInStyle', { style: formatted.styleLabel }))
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

  const openPdfPicker = (projectId: string, targetReferenceId: string | null): void => {
    setAttachToReferenceId(targetReferenceId)
    setSelectedPdfIds([])
    setShowPdfPicker(true)
    void loadPdfCandidates(projectId)
  }

  const handleAttachSelectedToRecord = async (referenceId: string): Promise<void> => {
    const selected = pdfCandidates.filter((candidate) => selectedPdfIds.includes(candidate.id))
    if (selected.length === 0) return
    cancelImportRef.current = false
    setImportProgress({ done: 0, total: selected.length })
    let done = 0
    for (const candidate of selected) {
      if (cancelImportRef.current) break
      try {
        await window.api.references.attachPdf(referenceId, candidate.id)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      done += 1
      setImportProgress({ done, total: selected.length })
    }
    setImportProgress(null)
    setShowPdfPicker(false)
    setAttachToReferenceId(null)
    setSelectedPdfIds([])
    setPdfCandidates([])
    setNotice(t('references.addedToCollection'))
    await refresh()
  }

  const handleImportSelectedPdfs = async (projectId: string): Promise<void> => {
    const selected = pdfCandidates.filter((candidate) => selectedPdfIds.includes(candidate.id))
    if (selected.length === 0) return
    cancelImportRef.current = false
    setImportProgress({ done: 0, total: selected.length })
    let imported = 0
    let failed = 0
    for (const candidate of selected) {
      if (cancelImportRef.current) break
      try {
        const title = candidate.name
          .replace(/\.pdf$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim()
        const added = await window.api.references.add({
          projectId,
          title: title || candidate.name,
          authors: [],
          sourceConnector: 'manual',
          notes: `Imported from project file: ${candidate.name}`
        })
        if (added.status === 'created') {
          await window.api.references.attachPdf(added.reference.id, candidate.id)
          imported += 1
        } else {
          // A record with this title/identity already exists: attach the PDF to it instead of
          // creating a duplicate entry.
          const existing = added.duplicateOf[0]
          if (existing && !existing.pdfManagedFileId) {
            await window.api.references.attachPdf(existing.id, candidate.id)
          }
          imported += 1
        }
      } catch {
        failed += 1
      }
      setImportProgress({ done: imported + failed, total: selected.length })
    }
    const stopped = cancelImportRef.current
    setImportProgress(null)
    setShowPdfPicker(false)
    setSelectedPdfIds([])
    setPdfCandidates([])
    setNotice(
      `${stopped ? '已停止 · ' : ''}已导入 ${imported} 个 PDF${failed > 0 ? `，${failed} 个失败` : ''}。`
    )
    await refresh()
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
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[95] bg-black/40" />
        <Dialog.Content
          aria-label={t('references.title')}
          aria-describedby={undefined}
          onOpenAutoFocus={focusRestore.onOpenAutoFocus}
          onCloseAutoFocus={focusRestore.onCloseAutoFocus}
          className="fixed left-1/2 top-1/2 z-[95] flex h-[82vh] w-[min(1080px,92vw)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl outline-none -translate-x-1/2 -translate-y-1/2"
        >
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
              <RefreshCw
                className={`size-3 ${fetching ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {fetching ? t('references.fetching') : t('references.fetch')}
            </button>
            <button type="button" className={ghostClass} onClick={() => setShowManual((v) => !v)}>
              <Plus className="size-3.5" aria-hidden="true" /> {t('references.manualAdd')}
            </button>
          </div>

          {showPdfPicker ? (
            <div className="mx-4 mt-2 rounded-lg border border-[var(--border)] px-3 py-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-[var(--foreground)]">
                  {attachToReferenceId
                    ? '选择要挂到该条目的 PDF'
                    : `从项目 PDF 批量入册（已选 ${selectedPdfIds.length}）`}
                </p>
                {importProgress ? (
                  <span className="flex items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
                    {importProgress.done}/{importProgress.total}
                    <button
                      type="button"
                      className={ghostClass}
                      onClick={() => {
                        cancelImportRef.current = true
                      }}
                    >
                      停止
                    </button>
                  </span>
                ) : null}
              </div>
              <div className="mt-2 max-h-40 overflow-y-auto rounded border border-[var(--border)] p-1">
                {pdfLoading ? (
                  <p className="px-2 py-3 text-[11px] text-[var(--muted-foreground)]">…</p>
                ) : pdfCandidates.length === 0 ? (
                  <p className="px-2 py-3 text-[11px] text-[var(--muted-foreground)]">
                    项目内没有 PDF 文件。
                  </p>
                ) : (
                  pdfCandidates.map((candidate) => (
                    <label
                      key={candidate.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] text-[var(--foreground)] hover:bg-[var(--border)]"
                    >
                      <input
                        type="checkbox"
                        checked={selectedPdfIds.includes(candidate.id)}
                        onChange={(event) => {
                          setSelectedPdfIds((current) =>
                            event.target.checked
                              ? [...current, candidate.id]
                              : current.filter((id) => id !== candidate.id)
                          )
                        }}
                      />
                      {candidate.name}
                    </label>
                  ))
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                {attachToReferenceId ? (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={selectedPdfIds.length === 0 || importProgress !== null}
                    onClick={() => void handleAttachSelectedToRecord(attachToReferenceId)}
                  >
                    挂到该条目（{selectedPdfIds.length}）
                  </button>
                ) : (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={selectedPdfIds.length === 0 || importProgress !== null || !projectId}
                    onClick={() => {
                      if (projectId) void handleImportSelectedPdfs(projectId)
                    }}
                  >
                    入册为新记录（{selectedPdfIds.length}）
                  </button>
                )}
                <button
                  type="button"
                  className={ghostClass}
                  disabled={importProgress !== null}
                  onClick={() => {
                    setShowPdfPicker(false)
                    setAttachToReferenceId(null)
                    setSelectedPdfIds([])
                    setPdfCandidates([])
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}

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
                <select
                  className="ml-2 max-w-56 rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-[10px]"
                  aria-label={t('references.citationStyle')}
                  value={selectedStyleId}
                  onChange={(event) => setSelectedStyleId(event.target.value)}
                >
                  <optgroup label={t('references.builtinStyles')}>
                    {citationStyles
                      .filter((style) => style.source === 'builtin')
                      .map((style) => (
                        <option key={style.id} value={style.id}>
                          {style.labelZh}
                        </option>
                      ))}
                  </optgroup>
                  {importedStyles.length > 0 ? (
                    <optgroup label={t('references.importedStyles')}>
                      {citationStyles
                        .filter((style) => style.source === 'imported')
                        .map((style) => (
                          <option key={style.id} value={style.id}>
                            {style.label}
                          </option>
                        ))}
                    </optgroup>
                  ) : null}
                </select>
                <button
                  type="button"
                  className={ghostClass}
                  onClick={() => void handleExportWithStyle()}
                >
                  <BookMarked className="size-3" aria-hidden="true" />{' '}
                  {t('references.exportWithStyle')}
                </button>
                <button
                  type="button"
                  className={ghostClass}
                  disabled={styleBusy}
                  onClick={() => styleFileInputRef.current?.click()}
                >
                  <Plus className="size-3" aria-hidden="true" /> {t('references.importCsl')}
                </button>
                <input
                  ref={styleFileInputRef}
                  type="file"
                  accept=".csl,.xml,application/xml,text/xml"
                  className="hidden"
                  aria-label={t('references.importCsl')}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) void handleImportCitationStyle(file)
                  }}
                />
                <button
                  type="button"
                  className={ghostClass}
                  onClick={() =>
                    setCompareTarget((current) => (current ? null : (shownReferences[0] ?? null)))
                  }
                  disabled={shownReferences.length === 0}
                >
                  {t('references.compareStyles')}
                </button>
                <button
                  type="button"
                  className={ghostClass}
                  onClick={() => {
                    if (projectId) openPdfPicker(projectId, null)
                  }}
                >
                  <BookMarked className="size-3" aria-hidden="true" /> PDF 入册
                </button>
              </div>
              {importedStyles.length > 0 ? (
                <div className="border-b border-[var(--border)] px-3 py-1">
                  <p className="text-[10px] text-[var(--muted-foreground)]">
                    {t('references.importedStylesHint')}
                  </p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {importedStyles.map((style) => (
                      <li key={style.id} className="flex items-center gap-2 text-[10px]">
                        <span className="font-medium text-[var(--foreground)]">{style.label}</span>
                        <span className="text-[var(--muted-foreground)]">
                          {t('references.styleLicense', { license: style.license })}
                        </span>
                        {style.unsupported.length > 0 ? (
                          <span className="text-amber-400">
                            {t('references.styleUnsupported', {
                              names: style.unsupported.join(', ')
                            })}
                          </span>
                        ) : null}
                        {style.fidelity === 'partial' ? (
                          <span
                            className="text-amber-400"
                            title={t('references.citationWarning.fidelityPartial')}
                          >
                            {t('references.styleFidelity', {
                              fidelity: style.fidelityNotes.join(', ') || 'partial'
                            })}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className={ghostClass}
                          onClick={() => void handleRemoveCitationStyle(style.id)}
                        >
                          {t('references.removeStyle')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {compareTarget ? (
                <div className="border-b border-[var(--border)] bg-[var(--accent)]/5 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[var(--foreground)]">
                      {t('references.compareStylesTitle')} · {compareTarget.title}
                    </span>
                    <button
                      type="button"
                      className={ghostClass}
                      onClick={() => setCompareTarget(null)}
                    >
                      {t('references.close')}
                    </button>
                  </div>
                  <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
                    {t('references.compareStylesHint')}
                  </p>
                  <ul className="mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto">
                    {compareCitationStyles(
                      citationItemFromReference(compareTarget),
                      citationStyles.map((style) => style.id),
                      { retrievedAt: todayIso() },
                      citationStyles
                    ).map((entry) => (
                      <li key={entry.styleId} className="text-[11px]">
                        <span className="font-medium text-[var(--foreground)]">
                          {entry.styleLabel}
                        </span>
                        <p className="whitespace-pre-wrap text-[var(--muted-foreground)]">
                          {entry.text || t('references.compareEmpty')}
                        </p>
                        {entry.warnings.length > 0 ? (
                          <p className="text-[10px] text-amber-400">
                            {entry.warnings
                              .map((warning) => describeCitationWarning(warning, t))
                              .join('；')}
                          </p>
                        ) : null}
                        {missingFieldsFromWarnings(entry.warnings).length > 0 ? (
                          <p className="text-[10px] text-[var(--muted-foreground)]">
                            {t('references.compareMissingFields', {
                              fields: missingFieldsFromWarnings(entry.warnings).join(', ')
                            })}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
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
                            {reference.pdfManagedFileId ? (
                              <span className="flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                                PDF · {reference.pdfManagedFileId.slice(-8)}
                                <button
                                  type="button"
                                  title={t('references.detachPdf')}
                                  onClick={() => void handleDetachPdf(reference.id)}
                                >
                                  <X className="size-3" aria-hidden="true" />
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className={ghostClass}
                                title={t('references.attachPdf')}
                                onClick={() => {
                                  if (projectId) openPdfPicker(projectId, reference.id)
                                }}
                              >
                                PDF
                              </button>
                            )}
                            <button
                              type="button"
                              className={ghostClass}
                              title={t('references.copyInStyle', {
                                style: selectedStyle?.label ?? ''
                              })}
                              onClick={() => void handleCopyInStyle(reference)}
                            >
                              {t('references.copyCitation')}
                            </button>
                            <button
                              type="button"
                              className={ghostClass}
                              title={t('references.compareStyles')}
                              onClick={() =>
                                setCompareTarget((current) =>
                                  current?.id === reference.id ? null : reference
                                )
                              }
                            >
                              {t('references.compareStyles')}
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
