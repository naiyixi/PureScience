import { useEffect, useState } from 'react'

import type { ManagedPreviewResource } from '../../../../../shared/preview-resources'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { createPreviewResourceKey } from './preview-resource-key'
import { createPreviewRequestScope } from './preview-file-reader'

type ManagedPreviewResourceState =
  | { status: 'idle'; resource?: undefined; error?: undefined }
  | { status: 'loading'; resource?: undefined; error?: undefined }
  | { status: 'ready'; resource: ManagedPreviewResource; error?: undefined }
  | { status: 'error'; resource?: undefined; error: Error }

const idleState: ManagedPreviewResourceState = { status: 'idle' }

// Releasing is best-effort. When the main process owns no such capability — for example right after a
// window is replaced and the command groups are composed again — there is nothing to release, and a
// rejection here would surface as a renderer console error and fail an unrelated certification spec.
const releaseQuietly = (resourceId: string): void => {
  void window.api.previewResources.release({ resourceId }).catch(() => undefined)
}

type ManagedPreviewResourceResult =
  | { requestKey: string; status: 'ready'; resource: ManagedPreviewResource }
  | { requestKey: string; status: 'error'; error: Error }

// Acquires and releases one managed-file capability with the component lifecycle.
const useManagedPreviewResource = (
  item: Pick<PreviewFileItem, 'path' | 'source' | 'mimeType' | 'size' | 'mtimeMs'> &
    Partial<Pick<PreviewFileItem, 'projectId' | 'sessionId'>> & { maxBytes?: number },
  enabled = true
): ManagedPreviewResourceState => {
  const [result, setResult] = useState<ManagedPreviewResourceResult | null>(null)
  // File metadata invalidates a capability when the same path is replaced in place.
  const requestKey = createPreviewResourceKey(item)
  const requestScope = createPreviewRequestScope(item)

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let acquiredResource: ManagedPreviewResource | undefined

    void window.api.previewResources
      .acquire({
        source: item.source ?? 'artifact',
        path: item.path,
        ...(requestScope.projectId ? { projectId: requestScope.projectId } : {}),
        ...(requestScope.sessionId ? { sessionId: requestScope.sessionId } : {}),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        ...(item.maxBytes === undefined ? {} : { maxBytes: item.maxBytes })
      })
      .then((resource) => {
        // Release acquisitions that complete after the consumer was unmounted or disabled.
        if (disposed) {
          releaseQuietly(resource.id)
          return
        }

        acquiredResource = resource
        setResult({ requestKey, status: 'ready', resource })
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setResult({
            requestKey,
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error))
          })
        }
      })

    return () => {
      disposed = true
      // Releasing the capability lets the main process forget the path and future protocol access.
      if (acquiredResource) {
        releaseQuietly(acquiredResource.id)
      }
      queueMicrotask(() => {
        setResult((currentResult) =>
          currentResult?.requestKey === requestKey ? null : currentResult
        )
      })
    }
  }, [
    enabled,
    item.mimeType,
    item.maxBytes,
    item.mtimeMs,
    item.path,
    item.projectId,
    item.sessionId,
    item.size,
    item.source,
    requestScope.projectId,
    requestScope.sessionId,
    requestKey
  ])

  if (!enabled) return idleState
  if (result?.requestKey !== requestKey) return { status: 'loading' }
  return result
}

export { useManagedPreviewResource }
export type { ManagedPreviewResourceState }
