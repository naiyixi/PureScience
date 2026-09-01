// Figure-review IPC handlers: the renderer's surface for the publication-grade correctness
// checklist (used by future UI; the agent-facing figure_review tool goes through the RPC
// gateway). The rule engine is pure logic in the main process.

import { ipcMainHandle } from '../ipc-handler-registry'
import type { FigureReviewRequest, FigureReviewResult } from '../../shared/figure'

export const FIGURE_IPC = {
  REVIEW: 'figure:review'
} as const

export type FigureCommandOwner = {
  review: (projectId: string, request: FigureReviewRequest) => Promise<FigureReviewResult>
}

export const createFigureCommandOwner = (
  review: (request: FigureReviewRequest) => FigureReviewResult
): FigureCommandOwner => ({
  review: (_projectId, request) => Promise.resolve(review(request))
})

export const registerFigureIpcHandlers = (owner: FigureCommandOwner): FigureCommandOwner => {
  ipcMainHandle(
    FIGURE_IPC.REVIEW,
    (_event, request: { projectId: string; request: FigureReviewRequest }) =>
      owner.review(request.projectId, request.request)
  )
  return owner
}

export type { FigureReviewRequest, FigureReviewResult }
