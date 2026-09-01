// File-annotation IPC handlers: the renderer's file-panel surface for annotations. The panel
// lists a project's annotations (list), attaches one (set), and removes one (remove). All
// mutations go through the main-process repository (single writer), matching the RPC gateway
// the agent-facing annotation_* tools use.

import { ipcMainHandle } from '../ipc-handler-registry'
import type { AnnotationRepository } from './annotation-repository'
import type { AnnotationSetRequest, FileAnnotation } from '../../shared/annotation'

export const ANNOTATION_IPC = {
  SET: 'annotation:set',
  LIST: 'annotation:list',
  REMOVE: 'annotation:remove'
} as const

export type AnnotationCommandOwner = {
  set: (
    projectId: string,
    request: AnnotationSetRequest
  ) => Promise<{ annotation: FileAnnotation; replaced: boolean }>
  list: (projectId: string, target?: string) => Promise<FileAnnotation[]>
  remove: (projectId: string, annotationId: string) => Promise<boolean>
}

export const createAnnotationCommandOwner = (
  repository: AnnotationRepository
): AnnotationCommandOwner => ({
  set: (projectId, request) => repository.set(projectId, request, 'user'),
  list: (projectId, target) => repository.list(projectId, target),
  remove: (projectId, annotationId) => repository.remove(projectId, annotationId)
})

export const registerAnnotationIpcHandlers = (
  owner: AnnotationCommandOwner
): AnnotationCommandOwner => {
  ipcMainHandle(
    ANNOTATION_IPC.SET,
    (_event, request: { projectId: string; request: AnnotationSetRequest }) =>
      owner.set(request.projectId, request.request)
  )
  ipcMainHandle(
    ANNOTATION_IPC.LIST,
    (_event, request: { projectId: string; target?: string }) =>
      owner.list(request.projectId, request.target)
  )
  ipcMainHandle(
    ANNOTATION_IPC.REMOVE,
    (_event, request: { projectId: string; annotationId: string }) =>
      owner.remove(request.projectId, request.annotationId)
  )
  return owner
}

export type { AnnotationSetRequest, FileAnnotation }
