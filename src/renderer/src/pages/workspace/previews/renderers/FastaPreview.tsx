import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'
import { useLanguage } from '@/i18n'

export const FastaPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const { t } = useLanguage()
  const state = usePreviewFileContent(item)

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t('previewFallback.fastaReadFailed')}
      />
    )
  }

  return (
    <SourcePreviewContent
      content={state.preview.content}
      pagination={state.pagination}
      lineClassName="break-all"
    />
  )
}
