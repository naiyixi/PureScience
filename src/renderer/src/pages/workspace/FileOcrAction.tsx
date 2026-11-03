import { ScanLine } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useState } from 'react'

import { useLanguage } from '@/i18n'
import { isImageFileName } from './file-ocr-name'
import { Button } from '@/components/ui/button'
import type { OcrRecogniseOutcome } from '../../../../shared/ocr'
import type { ManagedPreviewSource } from '../../../../shared/preview-resources'

// Images are the one kind of file whose text the product could not read at all: a photographed gel, a scan of a
// printed page, a screenshot of a table. The button appears only for those files, and the panel it opens either
// shows the recognised text with the engine and pack that read it, or says exactly why nothing was read —
// tesseract missing, that language's pack missing, or the file unreadable. It never shows an empty box for a
// failure.
export type FileOcrActionProps = {
  source: ManagedPreviewSource
  path: string
  name: string
  projectId?: string
  sessionId?: string
  disabled: boolean
  className: string
}

export const FileOcrAction = ({
  source,
  path,
  name,
  projectId,
  sessionId,
  disabled,
  className
}: FileOcrActionProps): React.JSX.Element | null => {
  const { t, lang } = useLanguage()
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState<OcrRecogniseOutcome | null>(null)

  if (!isImageFileName(name)) return null

  const run = async (): Promise<void> => {
    setOpen(true)
    setRunning(true)
    setOutcome(null)
    try {
      const result = await window.api.pdf.ocr({
        source,
        path,
        ...(projectId ? { projectId } : {}),
        ...(sessionId ? { sessionId } : {}),
        uiLanguage: lang
      })
      setOutcome(result)
    } catch (cause) {
      setOutcome({
        status: 'unreadable',
        message: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className={className}
        aria-label={t('files.ocr.open').replace('{name}', name)}
        title={t('files.ocr.open').replace('{name}', name)}
        disabled={disabled}
        data-slot="file-ocr-action"
        onClick={() => void run()}
      >
        <ScanLine aria-hidden="true" />
      </Button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/40" />
          <Dialog.Content
            data-slot="file-ocr-dialog"
            className="fixed left-1/2 top-1/2 z-[81] flex max-h-[80vh] w-[min(720px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-border-300 bg-bg-000 p-4 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-medium text-text-000">
                  {t('files.ocr.title')}
                </Dialog.Title>
                <Dialog.Description className="truncate text-[11px] text-text-300">
                  {name}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t('common.close')}>
                  ×
                </Button>
              </Dialog.Close>
            </div>

            {running ? (
              <p className="text-xs text-text-300" data-testid="file-ocr-running">
                {t('files.ocr.running')}
              </p>
            ) : outcome?.status === 'recognised' ? (
              <>
                <p className="text-[11px] text-text-400" data-testid="file-ocr-provenance">
                  {t('files.ocr.provenance', {
                    language: outcome.language,
                    pack: outcome.packFile,
                    ms: outcome.durationMs
                  })}
                </p>
                {outcome.text.trim() === '' ? (
                  <p className="text-xs text-text-300" data-testid="file-ocr-empty">
                    {t('files.ocr.empty')}
                  </p>
                ) : (
                  <pre
                    data-testid="file-ocr-text"
                    className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-300 bg-bg-100 p-2 text-xs text-text-000"
                  >
                    {outcome.text}
                  </pre>
                )}
              </>
            ) : outcome?.status === 'tool-missing' ? (
              <p className="text-xs text-warning-900" data-testid="file-ocr-tool-missing">
                {t('files.ocr.toolMissing')}
              </p>
            ) : outcome?.status === 'pack-missing' ? (
              <p className="text-xs text-warning-900" data-testid="file-ocr-pack-missing">
                {t('files.ocr.packMissing', {
                  pack: outcome.packFile,
                  installed: outcome.installed.join(', ') || '—'
                })}
              </p>
            ) : outcome?.status === 'unsupported-language' ? (
              <p className="text-xs text-warning-900" data-testid="file-ocr-unsupported">
                {t('files.ocr.unsupported', { language: outcome.uiLanguage })}
              </p>
            ) : outcome?.status === 'unreadable' ? (
              <p className="text-xs text-warning-900" data-testid="file-ocr-unreadable">
                {t('files.ocr.unreadable', { message: outcome.message })}
              </p>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
