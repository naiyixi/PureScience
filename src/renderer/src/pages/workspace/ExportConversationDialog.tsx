import { useMemo, useState } from 'react'
import { Download, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { ChatSession } from '@/stores/session-store'
import type {
  ConversationExportFormat,
  ConversationRoundSelection
} from '../../../../shared/conversation-export'

export type ExportConversationOptions = {
  format: ConversationExportFormat
  rounds?: ConversationRoundSelection
}

type ExportConversationDialogProps = {
  session: ChatSession | undefined
  onClose: () => void
  onExport: (options: ExportConversationOptions) => void
}

type RoundMode = 'all' | 'range' | 'single'

const parseRoundInput = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback
}

const ExportConversationDialog = ({
  session,
  onClose,
  onExport
}: ExportConversationDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const dialogSession = useRetainedDialogValue(session)
  const [format, setFormat] = useState<ConversationExportFormat>('markdown')
  const [roundMode, setRoundMode] = useState<RoundMode>('all')
  const [fromValue, setFromValue] = useState('1')
  const [toValue, setToValue] = useState('')
  const [singleValue, setSingleValue] = useState('1')

  const totalRounds = useMemo(
    () =>
      (dialogSession?.messages ?? []).reduce(
        (count, message) => count + (message.role === 'user' ? 1 : 0),
        0
      ),
    [dialogSession]
  )

  const from = parseRoundInput(fromValue, 1)
  const to = toValue.trim() === '' ? totalRounds : parseRoundInput(toValue, 1)
  const single = parseRoundInput(singleValue, 1)

  const rangeIsValid =
    roundMode === 'all' ||
    (roundMode === 'range' && from >= 1 && to >= from && to <= totalRounds) ||
    (roundMode === 'single' && single >= 1 && single <= totalRounds)

  const handleExport = (): void => {
    if (!dialogSession || !rangeIsValid) return
    const rounds: ConversationRoundSelection | undefined =
      roundMode === 'range'
        ? { from, to: Math.min(to, totalRounds) }
        : roundMode === 'single'
          ? { from: single, to: single }
          : undefined
    onExport({ format, rounds })
  }

  return (
    <Dialog.Root
      open={Boolean(dialogSession)}
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <Dialog.Overlay className={dialogOverlayClassName} />
      <Dialog.Content
        className={dialogPanelClassName('w-[26rem] max-w-[calc(100vw-2rem)]')}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          onClose()
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Dialog.Title className="text-sm font-semibold text-foreground">
              {t('ws.exportDialogTitle')}
            </Dialog.Title>
            <Dialog.Description className="mt-1 truncate text-xs text-muted-foreground">
              {dialogSession?.title}
            </Dialog.Description>
          </div>
          <button
            type="button"
            className={dialogCloseButtonClassName}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <fieldset>
            <legend className="text-xs font-medium text-muted-foreground">
              {t('ws.exportDialogFormat')}
            </legend>
            <div className="mt-1.5 flex gap-4">
              <label className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                <input
                  type="radio"
                  name="export-format"
                  checked={format === 'markdown'}
                  onChange={() => setFormat('markdown')}
                />
                Markdown
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                <input
                  type="radio"
                  name="export-format"
                  checked={format === 'pdf'}
                  onChange={() => setFormat('pdf')}
                />
                PDF
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend className="flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
              {t('ws.exportDialogRounds')}
              <span className="text-muted-foreground/70">
                {t('ws.exportDialogSessionRounds').replace('{n}', String(totalRounds))}
              </span>
            </legend>
            <div className="mt-1.5 space-y-2 text-sm text-foreground">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="export-rounds"
                  checked={roundMode === 'all'}
                  onChange={() => setRoundMode('all')}
                />
                {t('ws.exportDialogAllRounds')}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="export-rounds"
                  checked={roundMode === 'range'}
                  onChange={() => setRoundMode('range')}
                />
                {t('ws.exportDialogRange')}
                {roundMode === 'range' ? (
                  <span className="ml-2 inline-flex items-center gap-1.5 text-sm">
                    <input
                      type="number"
                      min={1}
                      max={totalRounds}
                      value={fromValue}
                      onChange={(event) => setFromValue(event.target.value)}
                      className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      aria-label={t('ws.exportDialogFrom')}
                    />
                    <span aria-hidden="true">–</span>
                    <input
                      type="number"
                      min={1}
                      max={totalRounds}
                      value={toValue}
                      onChange={(event) => setToValue(event.target.value)}
                      className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      aria-label={t('ws.exportDialogTo')}
                    />
                  </span>
                ) : null}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="export-rounds"
                  checked={roundMode === 'single'}
                  onChange={() => setRoundMode('single')}
                />
                {t('ws.exportDialogSingleRound')}
                {roundMode === 'single' ? (
                  <input
                    type="number"
                    min={1}
                    max={totalRounds}
                    value={singleValue}
                    onChange={(event) => setSingleValue(event.target.value)}
                    className="ml-2 w-16 rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    aria-label={t('ws.exportDialogRoundNumber')}
                  />
                ) : null}
              </label>
            </div>
            {!rangeIsValid ? (
              <p className="mt-1.5 text-xs text-destructive">{t('ws.exportDialogInvalidRange')}</p>
            ) : null}
          </fieldset>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleExport} disabled={!rangeIsValid}>
            <Download className="size-4" aria-hidden="true" />
            {t('common.export')}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}

export { ExportConversationDialog }
