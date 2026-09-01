/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 */
import { useCallback, useEffect, useState } from 'react'
import { MessageSquareText, Plus, Trash2, X } from 'lucide-react'

import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type {
  AnnotationLabel,
  AnnotationSetRequest,
  FileAnnotation
} from '../../../../shared/annotation'
import { ANNOTATION_LABELS } from '../../../../shared/annotation'

// File annotations dialog: shows the labeled notes attached to one file (project-relative
// path), lets the user add/replace a note for a label, and remove one. Backed by the
// annotation IPC surface (same store the agent's annotation_* tools use).
export const AnnotationDialog = ({
  open,
  projectId,
  target,
  onClose
}: {
  open: boolean
  projectId: string
  target: string
  onClose: () => void
}): React.JSX.Element | null => {
  const { t } = useLanguage()
  const [annotations, setAnnotations] = useState<FileAnnotation[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [label, setLabel] = useState<AnnotationLabel>('todo')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    if (!open) return
    setIsLoading(true)
    try {
      const items = await window.api.annotation.list({ projectId, target })
      setAnnotations(items)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setIsLoading(false)
    }
  }, [open, projectId, target])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  if (!open) return null

  const save = async (): Promise<void> => {
    if (saving || !note.trim()) return
    setSaving(true)
    try {
      const request: AnnotationSetRequest = {
        target,
        label,
        note: note.trim()
      }
      await window.api.annotation.set({ projectId, request })
      setNote('')
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (annotation: FileAnnotation): Promise<void> => {
    try {
      await window.api.annotation.remove({ projectId, annotationId: annotation.id })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('files.annotationsTitle')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border bg-card p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquareText className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t('files.annotationsTitle')}</h2>
          </div>
          <button
            type="button"
            aria-label={t('common.close')}
            className="rounded p-1 hover:bg-muted"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 truncate text-xs text-muted-foreground" title={target}>
          {target}
        </p>

        {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}

        {isLoading ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {t('files.annotationsLoading')}
          </p>
        ) : annotations.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {t('files.annotationsEmpty')}
          </p>
        ) : (
          <ul className="mb-3 max-h-56 space-y-2 overflow-y-auto">
            {annotations.map((annotation) => (
              <li
                key={annotation.id}
                className="flex items-start justify-between gap-2 rounded-lg border p-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <span
                    className={cn(
                      'inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                      labelColor(annotation.label)
                    )}
                  >
                    {annotation.label}
                  </span>
                  <p className="text-xs leading-relaxed">{annotation.note}</p>
                  {annotation.contentChecksum ? (
                    <p className="truncate font-mono text-[9px] text-muted-foreground">
                      sha256:{annotation.contentChecksum.slice(0, 12)}…
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label={t('files.annotationsRemove')}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                  onClick={() => void remove(annotation)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap gap-1">
            {ANNOTATION_LABELS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] font-medium capitalize',
                  label === candidate
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/70'
                )}
                onClick={() => setLabel(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder={t('files.annotationsNotePlaceholder')}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button size="sm" disabled={!note.trim() || saving} onClick={() => void save()}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('files.annotationsAdd')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

const labelColor = (label: AnnotationLabel): string => {
  switch (label) {
    case 'todo':
      return 'bg-amber-500/15 text-amber-600'
    case 'question':
      return 'bg-sky-500/15 text-sky-600'
    case 'important':
      return 'bg-red-500/15 text-red-600'
    case 'review':
      return 'bg-violet-500/15 text-violet-600'
    default:
      return 'bg-muted text-muted-foreground'
  }
}
