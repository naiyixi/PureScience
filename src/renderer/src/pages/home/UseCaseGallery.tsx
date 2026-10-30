import { Check, Copy, FlaskConical, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useState } from 'react'

import { useLanguage } from '@/i18n'
import { copyText } from '@/lib/copy-text'
import {
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'
import { useDialogFocusRestore } from '@/components/ui/dialog-focus-restore'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'

import type { UseCaseSample } from './use-case-gallery'
import { USE_CASE_SAMPLES, sampleKey } from './use-case-gallery'

// The gallery is the product's own evidence, laid out where a reader can open it: a card per capability
// that was actually run, and a panel holding the measured values, the words the run produced, and the
// command that reproduces them. It deliberately is not a screenshot wall — every number on the panel is
// copied out of an evidence file, and `use-case-gallery.test.ts` re-reads those files so the copy cannot
// drift into invention.

const cardClassName =
  'group flex h-full flex-col gap-2 rounded-2xl border border-border-200/70 bg-bg-000 p-4 text-left shadow-card transition-colors duration-150 ease-out hover:border-text-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

type GalleryDetailProps = {
  sample: UseCaseSample | undefined
  onClose: () => void
}

const UseCaseGalleryDetail = ({ sample, onClose }: GalleryDetailProps): React.JSX.Element => {
  const { t } = useLanguage()
  const focusRestore = useDialogFocusRestore(Boolean(sample))
  // Keeping the last sample through the close animation: unmounting on the same tick empties the panel
  // mid-fade and Radix warns about a content-less dialog.
  const dialogSample = useRetainedDialogValue(sample)
  // Tied to the command it copied rather than a boolean: opening a different sample must not keep
  // claiming "copied", and comparing the value does that without an effect that resets state.
  const [copiedCommand, setCopiedCommand] = useState<string | undefined>(undefined)
  const copied = dialogSample !== undefined && copiedCommand === dialogSample.command

  const handleCopy = (): void => {
    if (!dialogSample) return
    const command = dialogSample.command
    void copyText(command)
      .then(() => setCopiedCommand(command))
      .catch(() => setCopiedCommand(undefined))
  }

  return (
    <Dialog.Root
      open={Boolean(sample)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          data-slot="use-case-gallery-dialog"
          className={dialogPanelClassName('max-h-[85vh] w-[min(92vw,720px)] overflow-y-auto')}
          onOpenAutoFocus={focusRestore.onOpenAutoFocus}
          onCloseAutoFocus={focusRestore.onCloseAutoFocus}
        >
          {dialogSample ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Dialog.Title className="text-base font-semibold text-text-000">
                    {t(sampleKey(dialogSample.id, 'title'))}
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm leading-relaxed text-text-100">
                    {t(sampleKey(dialogSample.id, 'claim'))}
                  </Dialog.Description>
                </div>
                <Dialog.Close
                  className={dialogCloseButtonClassName}
                  aria-label={t('gallery.close')}
                >
                  <X className="size-4" strokeWidth={2} aria-hidden="true" />
                </Dialog.Close>
              </div>

              <section className="mt-5" data-slot="use-case-gallery-readings">
                <h3 className="text-xs font-medium uppercase tracking-wide text-text-300">
                  {t('gallery.readings')}
                </h3>
                <dl className="mt-2 divide-y divide-border-200/70 rounded-lg border border-border-200/70">
                  {dialogSample.readings.map((reading) => (
                    <div
                      key={`${reading.label}-${reading.value}`}
                      className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"
                    >
                      <dt className="font-mono text-[11px] text-text-300">{reading.label}</dt>
                      <dd className="min-w-0 break-all font-mono text-xs text-text-000">
                        {reading.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section className="mt-5" data-slot="use-case-gallery-quotes">
                <h3 className="text-xs font-medium uppercase tracking-wide text-text-300">
                  {t('gallery.quotes')}
                </h3>
                <ul className="mt-2 space-y-2">
                  {dialogSample.quotes.map((quote) => (
                    <li
                      key={quote.text}
                      className="rounded-lg border border-border-200/70 bg-bg-10 px-3 py-2"
                    >
                      <p className="whitespace-pre-wrap break-words font-mono text-xs text-text-000">
                        {quote.text}
                      </p>
                      <p className="mt-1 text-[11px] text-text-300">{quote.origin}</p>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="mt-5" data-slot="use-case-gallery-verify">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-text-300">
                    {t('gallery.verify')}
                  </h3>
                  <button
                    type="button"
                    onClick={handleCopy}
                    data-slot="use-case-gallery-copy"
                    className="inline-flex items-center gap-1 rounded-md border border-border-200/70 px-2 py-1 text-[11px] text-text-100 transition-colors duration-150 ease-out hover:border-text-300/60 hover:text-text-000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {copied ? (
                      <Check className="size-3" strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <Copy className="size-3" strokeWidth={2} aria-hidden="true" />
                    )}
                    {copied ? t('gallery.copied') : t('gallery.copyCommand')}
                  </button>
                </div>
                <code
                  data-slot="use-case-gallery-command"
                  className="mt-2 block whitespace-pre-wrap break-all rounded-lg border border-border-200/70 bg-bg-10 px-3 py-2 font-mono text-xs text-text-000"
                >
                  {dialogSample.command}
                </code>
                <p className="mt-2 text-sm leading-relaxed text-text-100">
                  {t(sampleKey(dialogSample.id, 'judgment'))}
                </p>
                <div className="mt-3">
                  <span className="text-xs text-text-300">{t('gallery.evidence')}</span>
                  <ul className="mt-1 space-y-1">
                    {dialogSample.evidence.map((file) => (
                      <li key={file} className="break-all font-mono text-[11px] text-text-100">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const UseCaseGallery = (): React.JSX.Element => {
  const { t } = useLanguage()
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const openSample = USE_CASE_SAMPLES.find((sample) => sample.id === openId)

  return (
    <section
      className="mt-8 sm:mt-10"
      aria-label={t('home.useCaseGallery')}
      data-slot="use-case-gallery"
    >
      <h2 className="mb-1 flex items-center gap-2 text-[17px] font-medium leading-6 text-text-000">
        <FlaskConical className="size-4 text-text-100" strokeWidth={2} aria-hidden="true" />
        {t('home.useCaseGallery')}
      </h2>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {t('home.useCaseGalleryIntro')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {USE_CASE_SAMPLES.map((sample) => (
          <button
            key={sample.id}
            type="button"
            data-slot={`use-case-gallery-card-${sample.id}`}
            aria-label={t('gallery.open', { title: t(sampleKey(sample.id, 'title')) })}
            className={cardClassName}
            onClick={() => setOpenId(sample.id)}
          >
            <span className="text-sm font-medium leading-snug text-text-000">
              {t(sampleKey(sample.id, 'title'))}
            </span>
            <span className="text-xs leading-relaxed text-text-100">
              {t(sampleKey(sample.id, 'claim'))}
            </span>
            <span className="mt-auto inline-flex w-fit max-w-full truncate rounded-md bg-bg-10 px-2 py-1 font-mono text-[11px] text-text-100">
              {sample.readings[0].value}
            </span>
          </button>
        ))}
      </div>
      <UseCaseGalleryDetail sample={openSample} onClose={() => setOpenId(undefined)} />
    </section>
  )
}

export { UseCaseGallery }
