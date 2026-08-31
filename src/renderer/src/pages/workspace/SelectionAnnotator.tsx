import { useEffect, useState } from 'react'
import { useLanguage } from '@/i18n'

import { ANNOTATION_MAX_TEXT_LENGTH } from '../../../../shared/annotations'

type SelectionAnnotatorProps = {
  onAnnotate: (source: string, text: string) => void
  disabled?: boolean
}

// Floating "add as annotation" affordance: when the user selects text inside the workspace, a small
// button appears near the selection. Clicking it stages the selected text as an annotation card
// for the next message. The source label is derived from the nearest annotated container.
const SelectionAnnotator = ({
  onAnnotate,
  disabled = false
}: SelectionAnnotatorProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  const [selection, setSelection] = useState<{
    text: string
    source: string
    x: number
    y: number
  } | null>(null)

  useEffect(() => {
    const resolveSource = (node: Node | null): string => {
      const element = node instanceof Element ? node : node?.parentElement
      const container = element?.closest<HTMLElement>('[data-annotation-source]')
      return container?.dataset.annotationSource ?? t('ws.annotationSourceFallback')
    }

    const onMouseUp = (): void => {
      if (disabled) {
        setSelection(null)
        return
      }
      const sel = window.getSelection()
      const text = sel?.toString().replace(/\s+/g, ' ').trim() ?? ''
      if (!sel || sel.isCollapsed || text.length === 0) {
        setSelection(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setSelection({
        text: text.slice(0, ANNOTATION_MAX_TEXT_LENGTH),
        source: resolveSource(sel.anchorNode),
        x: Math.min(rect.left + rect.width / 2, window.innerWidth - 110),
        y: Math.max(rect.top - 34, 8)
      })
    }

    const onScroll = (): void => setSelection(null)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [disabled, t])

  if (!selection) return null

  return (
    <button
      type="button"
      style={{ left: selection.x, top: selection.y }}
      onClick={() => {
        onAnnotate(selection.source, selection.text)
        setSelection(null)
      }}
      className="fixed z-modal rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white shadow-lg transition-opacity hover:opacity-90"
    >
      {t('ws.annotationAdd')}
    </button>
  )
}

export { SelectionAnnotator }
