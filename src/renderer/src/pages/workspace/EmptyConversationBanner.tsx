import { FlaskConical } from 'lucide-react'

import { useLanguage } from '@/i18n'

// Centered placeholder for a brand-new conversation with no messages yet. Mounted as an absolute
// overlay inside the message scroller (not the content container — the scroller only measures its
// direct children), so it never participates in scroll anchoring. Purely decorative.
const EmptyConversationBanner = (): React.JSX.Element => {
  const { t } = useLanguage()

  return (
    <div
      data-testid="empty-conversation-banner"
      className="pointer-events-none absolute inset-x-0 top-[42%] flex -translate-y-1/2 flex-col items-center gap-4 px-6 text-center"
    >
      <div className="flex size-28 items-center justify-center rounded-3xl bg-muted/60">
        <FlaskConical className="size-14 text-muted-foreground/60" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-balance text-2xl font-normal text-foreground md:text-3xl">
          {t('ws.whatWillYouResearch')}
        </h2>
        <p className="text-sm text-muted-foreground md:text-base">
          {t('ws.researchTagline')}
        </p>
      </div>
    </div>
  )
}

export { EmptyConversationBanner }
