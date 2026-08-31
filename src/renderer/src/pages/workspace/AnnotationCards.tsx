import { useLanguage } from '@/i18n'
import { ImageIcon, X } from 'lucide-react'

import type { ConversationAnnotation } from '../../../../shared/annotations'

type AnnotationCardsProps = {
  annotations: ConversationAnnotation[]
  onRemove: (annotationId: string) => void
}

// Staged annotation cards shown above the composer: user-selected workspace context that will be
// attached to the next message as cited context for the agent. Text cards carry the selection;
// image cards reference the selected region of an agent-generated image.
const AnnotationCards = ({
  annotations,
  onRemove
}: AnnotationCardsProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  if (annotations.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5 px-2 pb-1">
      {annotations.map((annotation) => (
        <div
          key={annotation.id}
          className="flex items-start gap-2 rounded-xl border border-border-200 bg-bg-100 px-2.5 py-2"
        >
          <span className="mt-0.5 shrink-0 rounded bg-bg-300 px-1.5 py-0.5 text-[10px] text-text-100">
            {annotation.source}
          </span>
          {annotation.kind === 'image' && (
            <span className="mt-0.5 shrink-0 rounded bg-bg-300 px-1.5 py-0.5 text-[10px] text-text-100">
              <ImageIcon className="mr-1 inline size-2.5" aria-hidden="true" />
              {t('ws.annotationImageRegionLabel')}
            </span>
          )}
          <p className="line-clamp-2 min-w-0 flex-1 text-xs leading-5 text-text-100">
            {annotation.kind === 'text'
              ? annotation.text
              : `${annotation.region.x.toFixed(2)}, ${annotation.region.y.toFixed(2)} — ${annotation.region.width.toFixed(2)} × ${annotation.region.height.toFixed(2)}`}
          </p>
          <button
            type="button"
            aria-label={t('ws.annotationRemove')}
            onClick={() => onRemove(annotation.id)}
            className="shrink-0 rounded p-0.5 text-text-300 transition-colors hover:bg-bg-300 hover:text-text-000"
          >
            <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}

export { AnnotationCards }
