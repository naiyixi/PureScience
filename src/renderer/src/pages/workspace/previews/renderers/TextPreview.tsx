import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'
import { useLanguage } from '@/i18n'

export const PreviewTextContent = ({
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
}): React.JSX.Element => {
  const { t } = useLanguage()
  const state = usePreviewFileContent({ path, source, projectId, sessionId })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t('previewFallback.fileReadFailed')}
      />
    )
  }

  return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
}

export const TextPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PreviewTextContent
    path={item.path}
    name={item.name}
    source={item.source}
    projectId={item.projectId}
    sessionId={item.sessionId}
  />
)
