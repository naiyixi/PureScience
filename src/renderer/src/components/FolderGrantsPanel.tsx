import { useCallback, useEffect, useState } from 'react'
import { useLanguage } from '@/i18n'
import { FolderOpen, RefreshCw, Trash2, X } from 'lucide-react'

import type { FolderGrant, FolderGrantsSnapshot } from '../../../shared/folder-grants'
import type { LocalDirListing } from '../../../shared/local-fs'

type FolderGrantsPanelProps = {
  open: boolean
  onClose: () => void
  onGranted?: (grant: FolderGrant) => void
}

// Manage user-linked folders (`@path/to/folder`): browse local volumes, grant a directory for
// agent read access, list and revoke existing grants. Grants persist across sessions in main.
const FolderGrantsPanel = ({ open, onClose, onGranted }: FolderGrantsPanelProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  const [grants, setGrants] = useState<FolderGrant[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [listing, setListing] = useState<LocalDirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [granting, setGranting] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const snapshot: FolderGrantsSnapshot = await window.api.folderGrants.list()
      setGrants([...snapshot.grants])
    } catch {
      setError(t('ws.folderGrantsError'))
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    setError(null)
    void refresh()
    void listDir('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const listDir = useCallback(
    async (path: string): Promise<void> => {
      setError(null)
      try {
        const next: LocalDirListing = await window.api.localFs.listDir(path)
        setCurrentPath(next.resolvedPath)
        setListing(next)
      } catch {
        setError(t('ws.folderGrantsBrowseError'))
      }
    },
    [t]
  )

  const grantCurrent = async (): Promise<void> => {
    if (!currentPath || granting) return
    setGranting(true)
    setError(null)
    try {
      const grant = await window.api.folderGrants.grant({ path: currentPath })
      onGranted?.(grant)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('ws.folderGrantsError'))
    } finally {
      setGranting(false)
    }
  }

  const revoke = async (rootId: string): Promise<void> => {
    await window.api.folderGrants.revoke({ rootId })
    await refresh()
  }

  if (!open) return null

  const directories = listing?.entries.filter((entry) => entry.isDirectory) ?? []

  return (
    <div
      className="fixed inset-0 z-modal grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('ws.folderGrantsTitle')}
      onClick={onClose}
    >
      <div
        className="w-[min(520px,calc(100vw-2rem))] rounded-2xl border border-border-200 bg-bg-000 p-4 shadow-menu"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-000">
            <FolderOpen className="size-4" strokeWidth={2} aria-hidden="true" />
            {t('ws.folderGrantsTitle')}
          </h2>
          <button
            type="button"
            aria-label={t('ws.folderGrantsClose')}
            onClick={onClose}
            className="rounded p-1 text-text-300 hover:bg-bg-200 hover:text-text-000"
          >
            <X className="size-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <p className="mt-1 text-xs leading-5 text-text-100">{t('ws.folderGrantsHint')}</p>

        {error ? <p className="mt-2 rounded-lg bg-danger-900/40 px-2 py-1 text-xs text-danger-000">{error}</p> : null}

        {/* Directory browser */}
        <div className="mt-3 rounded-xl border border-border-200 bg-bg-100 p-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label={t('ws.folderGrantsRefresh')}
              onClick={() => void listDir('')}
              className="rounded p-1 text-text-300 hover:bg-bg-200 hover:text-text-000"
            >
              <RefreshCw className="size-3.5" strokeWidth={2} aria-hidden="true" />
            </button>
            <input
              value={currentPath}
              onChange={(event) => setCurrentPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void listDir(currentPath)
              }}
              aria-label={t('ws.folderGrantsPath')}
              className="h-7 min-w-0 flex-1 rounded-lg border border-border-200 bg-bg-000 px-2 text-xs text-text-000 outline-none focus-visible:border-ring"
            />
            <button
              type="button"
              onClick={() => void listDir(currentPath)}
              className="rounded-lg bg-bg-300 px-2 py-1 text-xs text-text-100 hover:bg-bg-400 hover:text-text-000"
            >
              {t('ws.folderGrantsGo')}
            </button>
          </div>
          <div className="mt-1.5 max-h-44 overflow-y-auto">
            {directories.map((entry) => {
              const childPath = `${currentPath.replace(/\/$/, '')}/${entry.name}`
              return (
                <button
                  key={childPath}
                  type="button"
                  onClick={() => void listDir(childPath)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-xs text-text-100 hover:bg-bg-200 hover:text-text-000"
                >
                  <FolderOpen className="size-3.5 shrink-0 text-text-300" strokeWidth={2} aria-hidden="true" />
                  <span className="truncate">{entry.name}</span>
                </button>
              )
            })}
            {directories.length === 0 ? (
              <p className="px-2 py-2 text-xs text-text-300">{t('ws.folderGrantsNoDirs')}</p>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          disabled={!currentPath || granting}
          onClick={() => void grantCurrent()}
          className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity disabled:opacity-40"
        >
          {granting ? t('ws.folderGrantsGranting') : t('ws.folderGrantsGrant')}
        </button>

        {/* Existing grants */}
        {grants.length > 0 ? (
          <div className="mt-3 border-t border-border-200 pt-2">
            <p className="mb-1.5 text-xs font-medium text-text-100">{t('ws.folderGrantsLinked')}</p>
            {grants.map((grant) => (
              <div
                key={grant.rootId}
                className="flex items-center gap-2 rounded-lg bg-bg-100 px-2 py-1.5"
              >
                <FolderOpen className="size-3.5 shrink-0 text-text-300" strokeWidth={2} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-xs text-text-000" title={grant.rootPath}>
                  {grant.label}
                </span>
                <span className="shrink-0 truncate text-[10px] text-text-300">{grant.rootPath}</span>
                <button
                  type="button"
                  aria-label={t('ws.folderGrantsRevoke')}
                  onClick={() => void revoke(grant.rootId)}
                  className="shrink-0 rounded p-1 text-text-300 hover:bg-bg-200 hover:text-danger-000"
                >
                  <Trash2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export { FolderGrantsPanel }
