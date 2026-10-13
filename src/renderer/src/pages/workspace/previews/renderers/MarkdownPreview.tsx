import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'
import { useLanguage } from '@/i18n'

export const MarkdownPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const { t } = useLanguage()
  const state = usePreviewFileContent(item)

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t('previewFallback.markdownReadFailed')}
      />
    )
  }

  if (state.preview.truncated || state.pagination.pageNumber > 1) {
    return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
  }

  return (
    <div className="size-full overflow-auto bg-bg-10 p-4">
      <AgentMarkdown content={state.preview.content} />
    </div>
  )
}
